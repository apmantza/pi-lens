// flake-shape: real-process-spawn — the cancel and the busy count are observed through a real JSON-RPC connection to a real child; lsp-spawn-heavy serializes it.
// flake-shape: elapsed-time-assertion — acceptance 3 of #5097 is a wall bound: Esc returns within 500 ms of the abort, measured from the abort to the caller's resume against a server that never answers.
// flake-shape: ungoverned-wait-for — the abort must land after the request is on the wire, and only the server's own trace shows that; the poll is bounded by its timeout.
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
 *
 * The last block is the other half of the same issue: a firing BOUND (not a
 * timeout) cancels the pull and the ping its work started. Its recurrence is
 * stated there.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getServersForFileWithConfig } = vi.hoisted(() => ({
	getServersForFileWithConfig: vi.fn(),
}));

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

import { afterEach } from "vitest";
import {
	type ActionableWarningsReport,
	type BuildActionableWarningsArgs,
	enrichFileFromLsp,
} from "../../../clients/actionable-warnings.js";
import { resetDegradationLedger } from "../../../clients/degradation-ledger.js";
import { _setServersForFileForTests } from "../../../clients/lsp/config.js";
import { runPersistentReverify } from "../../../clients/persistent-reverify.js";
import {
	createLSPClient,
	type LSPClientInfo,
} from "../../../clients/lsp/client.js";
import { LSPService } from "../../../clients/lsp/index.js";
import { type LSPProcess, stopLSP } from "../../../clients/lsp/launch.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { LspRequestTimeoutError } from "../../../clients/lsp/request-timeout-error.js";
import { spawnAbortScope } from "../../../clients/spawn-abort-scope.js";
import { createLspNavigationTool } from "../../../tools/lsp-navigation.js";
import { installLspService } from "../../support/lsp-service-seam.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";
import { removeTempDirSync } from "../test-utils.js";

afterEach(() => {
	if (previous.nav === undefined)
		delete process.env.PI_LENS_LSP_NAV_REQUEST_TIMEOUT_MS;
	else process.env.PI_LENS_LSP_NAV_REQUEST_TIMEOUT_MS = previous.nav;
	if (previous.ping === undefined)
		delete process.env.PI_LENS_LSP_LIVENESS_PING_TIMEOUT_MS;
	else process.env.PI_LENS_LSP_LIVENESS_PING_TIMEOUT_MS = previous.ping;
	if (previous.exec === undefined)
		delete process.env.PI_LENS_LSP_EXECUTE_COMMAND_TIMEOUT_MS;
	else process.env.PI_LENS_LSP_EXECUTE_COMMAND_TIMEOUT_MS = previous.exec;
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

describe("a firing bound cancels the request its LSP work started (#5097)", () => {
	let tmp: string;
	let trace: string;
	let service: LSPService;
	const procs: LSPProcess[] = [];

	beforeEach(() => {
		_setServersForFileForTests(getServersForFileWithConfig);
		tmp = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ambient-5097-")),
		);
		trace = path.join(tmp, "trace.log");
		resetDegradationLedger();
		service = new LSPService();
	});
	afterEach(async () => {
		_setServersForFileForTests(undefined);
		await service.shutdown();
		procs.length = 0;
		removeTempDirSync(tmp);
	});

	/** One pull-mode server on `.fkr` files that hangs `hang` and ignores cancels. */
	function register(hang: string): string {
		const filePath = path.join(tmp, "main.fkr");
		fs.writeFileSync(filePath, "fn main() {}\n");
		const server = {
			id: "fake-rust",
			name: "fake-rust",
			extensions: [".fkr"],
			idleEviction: "resident",
			root: async () => tmp,
			spawn: async () => {
				const proc = await spawnFakeLspServer({
					cwd: tmp,
					env: {
						...process.env,
						FAKE_LSP_HANG_METHODS: hang,
						FAKE_LSP_TRACE_FILE: trace,
						PI_LENS_LSP_PULL_REQUEST_TIMEOUT_MS: "4000",
					},
				});
				procs.push(proc);
				return { process: proc, source: "test" };
			},
		};
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".fkr") ? [server] : [],
		);
		return filePath;
	}

	const lines = (): string[] =>
		fs.existsSync(trace) ? fs.readFileSync(trace, "utf-8").split("\n") : [];
	const cancels = (): number =>
		lines().filter((line) => line === "recv $/cancelRequest").length;
	/** Resolves once the server has read a request of this method. */
	const received = (method: string) =>
		vi.waitFor(
			() => {
				expect(lines().some((line) => line.startsWith(`recv ${method}`))).toBe(
					true,
				);
			},
			{ timeout: 8000, interval: 10 },
		);
	/** The cancel is on the wire within 500 ms of `abortedAt`. */
	const cancelledWithin500ms = async (abortedAt: number) => {
		await vi.waitFor(() => expect(cancels()).toBe(1), {
			timeout: 500,
			interval: 10,
		});
		expect(Date.now() - abortedAt).toBeLessThan(500);
	};

	function carriedReport(filePath: string): ActionableWarningsReport {
		const stamp = new Date().toISOString();
		return {
			generatedAt: stamp,
			scope: "turn_delta",
			sessionId: "s1",
			turnIndex: 1,
			deltaOnly: true,
			includeLspCodeActions: false,
			files: [
				{
					filePath,
					displayPath: "main.fkr",
					origin: "deferred",
					generatedAt: stamp,
					warnings: [
						{
							id: "w1",
							filePath,
							displayPath: "main.fkr",
							line: 1,
							severity: "warning",
							tool: "fake-rust",
							source: "fake-rust",
							code: "W1",
							rule: "fake-rust:W1",
							message: "unused",
							actions: [],
							suppressed: false,
							origin: "lsp",
						},
					],
				},
			],
			summary: {
				warnings: 1,
				unsuppressed: 1,
				suppressed: 0,
				files: 1,
				actions: 0,
				autoFixEligible: 0,
			},
		};
	}

	// The `persistent_reverify_touch` row of `BOUNDED_CALL_SITES`: the touch runs
	// in the bound's scope; before the fix the pull it sent read no abort, so
	// the request stayed on the server until its own 4 s ceiling.
	it("the persistent re-verify touch cancels its pull when the turn is aborted", async () => {
		const filePath = register("textDocument/diagnostic");
		const past = new Date(Date.now() - 60_000);
		fs.utimesSync(filePath, past, past);
		const turn = new AbortController();
		const pass = runPersistentReverify({
			report: carriedReport(filePath),
			cwd: tmp,
			lspService: service as never,
			signal: turn.signal,
			budgetMs: 6000,
		});
		await received("textDocument/diagnostic");
		const abortedAt = Date.now();
		turn.abort();
		const result = await pass;
		// The carried warning is kept and labelled: an aborted touch is no answer.
		expect(result.outcomes.map((o) => o.outcome)).toEqual(["unconfirmed"]);
		await cancelledWithin500ms(abortedAt);
	}, 20_000);

	// The `boundedLspCall` row in actionable-warnings: `getDiagnostics` is the
	// pull the bound's scope is meant to cancel.
	it("the enrichment's getDiagnostics pull is cancelled when the loop's signal aborts", async () => {
		const filePath = register("textDocument/diagnostic");
		const loop = new AbortController();
		const args: BuildActionableWarningsArgs = {
			cwd: tmp,
			sessionId: "s1",
			turnIndex: 0,
			files: [],
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: false,
			deltaOnly: false,
			dbg: () => {},
		};
		const enriched = enrichFileFromLsp(
			tmp,
			args,
			{ filePath, content: "fn main() {}\n" },
			{
				lspService: service as never,
				pullTimeoutMs: 6000,
				signal: loop.signal,
				site: { hook: "turn_end", label: "ambient-5097" },
			},
		);
		await received("textDocument/diagnostic");
		const abortedAt = Date.now();
		loop.abort();
		// Not checked is not clean: the file contributes no records.
		await expect(enriched).resolves.toEqual([]);
		await cancelledWithin500ms(abortedAt);
	}, 20_000);
});
