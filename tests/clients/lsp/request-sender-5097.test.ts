// flake-shape: real-process-spawn — the cancel and the busy count are observed through a real JSON-RPC connection to a real child; lsp-spawn-heavy serializes it.
/**
 * #5097: one LSP request sender owns cancel and release on timeout and abort.
 *
 * Recurrence this guards: the deadline audit (2026-11-13) found a timed-out or
 * Esc-aborted request that kept the connection busy and sent no
 * `$/cancelRequest`, at the liveness ping, `codeAction/resolve`, the mutating
 * `executeCommand` and navigation. A busy client is never evicted as idle
 * (`client-registry.ts`), and each ping of a wedged server added one more
 * pending request. Each case below hangs ONE method on the fake server
 * (`FAKE_LSP_HANG_METHODS`), which accepts it, never answers, and ignores a
 * cancel, then reads what the wire and the busy count say.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

const previous = vi.hoisted(() => {
	const saved = {
		nav: process.env.PI_LENS_LSP_NAV_REQUEST_TIMEOUT_MS,
		ping: process.env.PI_LENS_LSP_LIVENESS_PING_TIMEOUT_MS,
		exec: process.env.PI_LENS_LSP_EXECUTE_COMMAND_TIMEOUT_MS,
	};
	process.env.PI_LENS_LSP_NAV_REQUEST_TIMEOUT_MS = "1200";
	process.env.PI_LENS_LSP_LIVENESS_PING_TIMEOUT_MS = "300";
	process.env.PI_LENS_LSP_EXECUTE_COMMAND_TIMEOUT_MS = "600";
	return saved;
});

import { afterAll } from "vitest";
import {
	createLSPClient,
	type LSPClientInfo,
} from "../../../clients/lsp/client.js";
import { LSPService } from "../../../clients/lsp/index.js";
import { stopLSP } from "../../../clients/lsp/launch.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { LspRequestTimeoutError } from "../../../clients/lsp/request-timeout-error.js";
import { spawnAbortScope } from "../../../clients/spawn-abort-scope.js";
import { createLspNavigationTool } from "../../../tools/lsp-navigation.js";
import { installLspService } from "../../support/lsp-service-seam.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";
import { removeTempDirSync } from "../test-utils.js";

afterAll(() => {
	for (const [key, value] of [
		["PI_LENS_LSP_NAV_REQUEST_TIMEOUT_MS", previous.nav],
		["PI_LENS_LSP_LIVENESS_PING_TIMEOUT_MS", previous.ping],
		["PI_LENS_LSP_EXECUTE_COMMAND_TIMEOUT_MS", previous.exec],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

async function withHangingServer(
	hangMethods: string,
	body: (ctx: {
		client: LSPClientInfo;
		file: string;
		cancels: () => number;
		/** Resolves once the server has read a request of this method. */
		received: (method: string) => Promise<void>;
		/** An answered request: the server reads stdio in order, so by the time
		 *  it replies it has read every cancel sent before it. */
		barrier: () => Promise<void>;
	}) => Promise<void>,
): Promise<void> {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-sender-5097-"));
	const trace = path.join(tmp, "trace.log");
	const file = path.join(tmp, "a.ts");
	fs.writeFileSync(file, "function greet() {}\n");
	fs.writeFileSync(path.join(tmp, "package.json"), "{}");
	const proc = await spawnFakeLspServer({
		cwd: tmp,
		env: {
			...process.env,
			FAKE_LSP_HANG_METHODS: hangMethods,
			FAKE_LSP_TRACE_FILE: trace,
		},
	});
	const client = await createLSPClient({
		serverId: "fake",
		process: proc,
		root: tmp,
	});
	try {
		await client.notify.open(file, "function greet() {}\n", "typescript");
		const cancels = () =>
			fs.existsSync(trace)
				? fs
						.readFileSync(trace, "utf-8")
						.split("\n")
						.filter((line) => line === "recv $/cancelRequest").length
				: 0;
		await body({
			client,
			file,
			cancels,
			received: async (method) => {
				await vi.waitFor(
					() => {
						const lines = fs.existsSync(trace)
							? fs.readFileSync(trace, "utf-8").split("\n")
							: [];
						expect(
							lines.some((line) => line.startsWith(`recv ${method}`)),
						).toBe(true);
					},
					{ timeout: 5000, interval: 10 },
				);
			},
			barrier: async () => {
				await client.hover(file, 0, 1);
			},
		});
	} finally {
		try {
			await client.shutdown();
		} catch {
			/* ignore */
		}
		try {
			await stopLSP(proc);
		} catch {
			/* ignore */
		}
		removeTempDirSync(tmp);
	}
}

describe("one request sender owns cancel and release (#5097)", () => {
	it("a timed-out mutating executeCommand releases the busy count and sends no cancel", async () => {
		await withHangingServer("workspace/executeCommand", async (ctx) => {
			const res = await ctx.client.executeCommand("fake.doThing", []);
			expect(res.executed).toBe(false);
			expect(res.reason).toContain("timed out after 600ms");
			// Released locally, by the time the caller sees the result.
			expect(ctx.client.isBusy?.()).toBe(false);
			await ctx.barrier();
			// The command may still be applying: documented no-cancel.
			expect(ctx.cancels()).toBe(0);
		});
	}, 15_000);

	it("each timed-out liveness ping is cancelled and released, so a wedged server does not pile up requests", async () => {
		await withHangingServer("workspace/symbol", async (ctx) => {
			const verdicts = [
				await ctx.client.pingLiveness?.(),
				await ctx.client.pingLiveness?.(),
				await ctx.client.pingLiveness?.(),
			];
			expect(verdicts).toEqual([false, false, false]);
			expect(ctx.client.isBusy?.()).toBe(false);
			await ctx.barrier();
			expect(ctx.cancels()).toBe(3);
		});
	}, 15_000);

	it("a timed-out codeAction/resolve is cancelled and released, and the lightweight action is kept", async () => {
		await withHangingServer("codeAction/resolve", async (ctx) => {
			const actions = await ctx.client.codeAction(ctx.file, 0, 0, 0, 5);
			expect(actions).toHaveLength(1);
			expect(actions[0]?.title).toBe("Replace greeting");
			expect(actions[0]?.edit).toBeUndefined();
			expect(ctx.client.isBusy?.()).toBe(false);
			await ctx.barrier();
			expect(ctx.cancels()).toBe(1);
		});
	}, 15_000);

	it("Esc during a codeAction/resolve the server never answers returns the lightweight action within 500 ms", async () => {
		await withHangingServer("codeAction/resolve", async (ctx) => {
			const abort = new AbortController();
			const call = spawnAbortScope.run(abort.signal, () =>
				ctx.client.codeAction(ctx.file, 0, 0, 0, 5),
			);
			await ctx.received("codeAction/resolve");
			const abortedAt = Date.now();
			abort.abort();
			const actions = await call;
			expect(Date.now() - abortedAt).toBeLessThan(500);
			expect(actions).toHaveLength(1);
			expect(actions[0]?.edit).toBeUndefined();
			expect(ctx.client.isBusy?.()).toBe(false);
			await ctx.barrier();
			expect(ctx.cancels()).toBe(1);
		});
	}, 15_000);

	it("a timed-out navigation request is cancelled and released and still throws the timeout", async () => {
		await withHangingServer("textDocument/documentSymbol", async (ctx) => {
			await expect(ctx.client.documentSymbol(ctx.file)).rejects.toBeInstanceOf(
				LspRequestTimeoutError,
			);
			expect(ctx.client.isBusy?.()).toBe(false);
			await ctx.barrier();
			expect(ctx.cancels()).toBe(1);
		});
	}, 15_000);

	it("Esc returns a silent navigation call within 500 ms with one cancel and the busy count released", async () => {
		await withHangingServer("textDocument/documentSymbol", async (ctx) => {
			const abort = new AbortController();
			const call = spawnAbortScope.run(abort.signal, () =>
				ctx.client.documentSymbol(ctx.file),
			);
			await ctx.received("textDocument/documentSymbol");
			const abortedAt = Date.now();
			abort.abort();
			const result = await call;
			const sinceAbort = Date.now() - abortedAt;
			expect(result).toEqual([]);
			expect(sinceAbort).toBeLessThan(500);
			expect(ctx.client.isBusy?.()).toBe(false);
			await ctx.barrier();
			expect(ctx.cancels()).toBe(1);
			// The timeout that would have fired later must not cancel again.
			await new Promise((resolve) => setTimeout(resolve, 1300));
			await ctx.barrier();
			expect(ctx.cancels()).toBe(1);
		});
	}, 15_000);

	it("an lsp_navigation tool call on a silent server returns within 500 ms of Esc", async () => {
		await withHangingServer("textDocument/documentSymbol", async (ctx) => {
			const service = new LSPService();
			(
				service as unknown as { state: { clients: Map<string, unknown> } }
			).state.clients.set(
				`typescript:${normalizeMapKey(path.dirname(ctx.file))}`,
				ctx.client,
			);
			installLspService(service);
			const abort = new AbortController();
			// The registration loop (index.ts) puts the call's signal in this scope.
			const call = spawnAbortScope.run(abort.signal, () =>
				createLspNavigationTool((flag) => flag === "lens-lsp").execute(
					"esc-on-silent-server",
					{ operation: "documentSymbol", path: ctx.file, view: "json" },
					abort.signal,
					null,
					{ cwd: path.dirname(ctx.file) },
				),
			);
			await ctx.received("textDocument/documentSymbol");
			const abortedAt = Date.now();
			abort.abort();
			await call;
			expect(Date.now() - abortedAt).toBeLessThan(500);
			expect(ctx.client.isBusy?.()).toBe(false);
			await ctx.barrier();
			expect(ctx.cancels()).toBe(1);
		});
	}, 15_000);
});
