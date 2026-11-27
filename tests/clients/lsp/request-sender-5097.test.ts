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
	process.env.PI_LENS_LSP_LIVENESS_PING_TIMEOUT_MS = "1200";
	process.env.PI_LENS_LSP_EXECUTE_COMMAND_TIMEOUT_MS = "600";
	return saved;
});

import { afterEach } from "vitest";
import {
	type ActionableWarningsReport,
	type BuildActionableWarningsArgs,
	enrichFileFromLsp,
} from "../../../clients/actionable-warnings.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { getRecentLoggedPhases } from "../../../clients/latency-logger.js";
import { setAmbientAbortSignal } from "../../../clients/safe-spawn.js";
import { _setServersForFileForTests } from "../../../clients/lsp/config.js";
import { bounded } from "../../../clients/deadline-utils.js";
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
	options: {
		env?: Record<string, string>;
		serverId?: string;
		launchVariant?: "classic";
		/** false: the body opens the file itself, inside its own abort scope. */
		open?: boolean;
	} = {},
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
			...options.env,
		},
	});
	const client = await createLSPClient({
		serverId: options.serverId ?? "fake",
		process: proc,
		root: tmp,
		...(options.launchVariant && { launchVariant: options.launchVariant }),
	});
	try {
		if (options.open !== false) {
			await client.notify.open(file, "function greet() {}\n", "typescript");
		}
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

	// Recurrence: an Esc'd pull treated as a timeout's twin must leave the same
	// bookkeeping (#1889: a repeat touch of a server that ignores the cancel
	// must not stack a second pull behind the first) and none of the timeout's
	// records (an Esc is no degradation), and one begun after the Esc must not
	// be sent only to be cancelled.
	it("an aborted pull is tracked as abandoned and records no failure, and a pull begun after the abort sends nothing", async () => {
		await withHangingServer("textDocument/diagnostic", async (ctx) => {
			const pulls = () => {
				const trace = path.join(path.dirname(ctx.file), "trace.log");
				return fs.existsSync(trace)
					? fs
							.readFileSync(trace, "utf-8")
							.split("\n")
							.filter((line) => line.startsWith("recv textDocument/diagnostic"))
							.length
					: 0;
			};
			// Begun under a scope that is already aborted: nothing is sent.
			const gone = new AbortController();
			gone.abort();
			await spawnAbortScope.run(gone.signal, () =>
				ctx.client.waitForDiagnostics(ctx.file, 300),
			);
			await ctx.barrier();
			expect(pulls()).toBe(0);
			const abort = new AbortController();
			const first = spawnAbortScope.run(abort.signal, () =>
				ctx.client.waitForDiagnostics(ctx.file, 600),
			);
			await ctx.received("textDocument/diagnostic");
			abort.abort();
			await first;
			expect(pulls()).toBe(1);
			// The server ignored the cancel, so the request is still pending: a
			// touch outside any scope must not send a second one behind it.
			await ctx.client.waitForDiagnostics(ctx.file, 300);
			await ctx.barrier();
			expect(pulls()).toBe(1);
			expect(ctx.client.getPullFailureHistory?.()).toEqual([]);
		});
	}, 15_000);

	// Recurrence (#5654 review F2): nothing pinned that an aborted pull never reads
	// clean. Returning `clean` from the abort branch (cancel and tracking kept)
	// passed every case: the touch would have been CONFIRMED on a request nobody
	// answered. The wait lapses, and lapsing is the only thing it may report.
	it("an aborted wait lapses and never answers, however fast the abort lands", async () => {
		await withHangingServer("textDocument/diagnostic", async (ctx) => {
			const abort = new AbortController();
			const startedAt = Date.now();
			const wait = spawnAbortScope.run(abort.signal, () =>
				ctx.client.waitForDiagnostics(ctx.file, 5000),
			);
			await ctx.received("textDocument/diagnostic");
			abort.abort();
			await expect(wait).resolves.toBe("deadline-expired");
			expect(Date.now() - startedAt).toBeLessThan(2500);
			// Begun under a scope that is already aborted: lapsed at once too.
			await expect(
				spawnAbortScope.run(abort.signal, () =>
					ctx.client.waitForDiagnostics(ctx.file, 5000),
				),
			).resolves.toBe("deadline-expired");
		});
	}, 15_000);

	it("an aborted liveness ping is cancelled and released and answers dead, never alive", async () => {
		await withHangingServer("workspace/symbol", async (ctx) => {
			const abort = new AbortController();
			const ping = ctx.client.pingLiveness?.(undefined, abort.signal);
			await ctx.received("workspace/symbol");
			const abortedAt = Date.now();
			abort.abort();
			// Aborted well inside the 1200 ms ping ceiling: the verdict is the
			// abort's, and an abort proves nothing about the server.
			expect(await ping).toBe(false);
			expect(Date.now() - abortedAt).toBeLessThan(500);
			expect(ctx.client.isBusy?.()).toBe(false);
			await ctx.barrier();
			expect(ctx.cancels()).toBe(1);
		});
	}, 15_000);

	it("a timed-out codeAction/resolve is cancelled and released, and the lightweight action is kept", async () => {
		await withHangingServer("codeAction/resolve", async (ctx) => {
			const actions = await ctx.client.codeAction(ctx.file, 0, 0, 0, 5);
			expect(actions).toHaveLength(1);
			expect(actions?.[0]?.title).toBe("Replace greeting");
			expect(actions?.[0]?.edit).toBeUndefined();
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
			expect(actions?.[0]?.edit).toBeUndefined();
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

	/**
	 * One server on `.fkr` files that hangs `hang` and ignores cancels: pull-mode
	 * by default, or push-only and silent under the wait-policy id `lua`, whose
	 * strategy marks it `silentOnClean` (the id that reaches the clean-confirm ping).
	 */
	function register(
		hang: string,
		serverId = "fake-rust",
		extraEnv: Record<string, string> = {},
	): string {
		const filePath = path.join(tmp, "main.fkr");
		fs.writeFileSync(filePath, "fn main() {}\n");
		const server = {
			id: serverId,
			name: serverId,
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
						...(serverId === "lua" && { FAKE_LSP_NO_DIAGNOSTIC_PROVIDER: "1" }),
						PI_LENS_LSP_PULL_REQUEST_TIMEOUT_MS: "4000",
						...extraEnv,
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

	/** The subjects `bounded` recorded as a deadline exceedance. */
	const exceeded = (): string[] =>
		getDegradationSummary()
			.find((group) => group.kind === "hook-await-exceeded")
			?.latestReasons.map((entry) => entry.subject) ?? [];

	// The same two registry rows, when the bound's DEADLINE fires rather than
	// the turn's abort (#5550). The bound is 700 ms on a client already
	// started; the pull's own timeout follows the touch's wait (about 1.5 s
	// here), so a cancel inside 500 ms of the return is the bound's. Recurrence:
	// a deadline that only abandoned the touch left the pull on the server until
	// its own timeout (the #5550 audit: "a bound that fires on its DEADLINE
	// aborts nothing").
	it("the persistent re-verify touch cancels its pull when the bound's deadline fires", async () => {
		const filePath = register("textDocument/diagnostic");
		await service.openFile(filePath, "fn main() {}\n");
		const past = new Date(Date.now() - 60_000);
		fs.utimesSync(filePath, past, past);
		const pass = runPersistentReverify({
			report: carriedReport(filePath),
			cwd: tmp,
			lspService: service as never,
			signal: new AbortController().signal,
			budgetMs: 700,
		});
		await received("textDocument/diagnostic");
		const result = await pass;
		const returnedAt = Date.now();
		expect(result.outcomes.map((o) => o.outcome)).toEqual(["unconfirmed"]);
		expect(exceeded()).toContain("turn_end:persistent_reverify_touch");
		await cancelledWithin500ms(returnedAt);
	}, 20_000);

	it("the enrichment's getDiagnostics pull is cancelled when the per-trip bound's deadline fires", async () => {
		const filePath = register("textDocument/diagnostic");
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
				pullTimeoutMs: 700,
				signal: new AbortController().signal,
				site: { hook: "turn_end", label: "deadline-5550" },
			},
		);
		await received("textDocument/diagnostic");
		await expect(enriched).resolves.toEqual([]);
		const returnedAt = Date.now();
		expect(exceeded()).toContain("turn_end:deadline-5550");
		await cancelledWithin500ms(returnedAt);
	}, 20_000);

	// The clean-confirm ping in `touchFile` (`lsp_silent_clean_confirm`): a push-only
	// server silent on clean is trusted only after it answers a round trip, and
	// that round trip read no abort either. The ping's own ceiling is 1200 ms
	// here, so a cancel inside 500 ms of the abort is the abort's, not the timer's.
	// Three call sites send it: the single-server gate (`primary`), the aggregate
	// gate (`all`), and the with-auxiliary per-edit gate — the last one added with
	// that gate, so its ping is covered by the same contract rather than assumed.
	it.each(["primary", "all", "with-auxiliary"] as const)(
		"the %s-scope clean-confirm ping is cancelled when the bound aborts, and the touch stays unconfirmed",
		async (clientScope) => {
			const filePath = register("workspace/symbol", "lua");
			if (clientScope === "with-auxiliary") {
				// The with-auxiliary gate refuses a client the touch itself started, so
				// a cold touch never reaches the ping this row is about (#5775 review
				// F2). Warm the client first with a touch that waits for nothing, and
				// show it sent no ping of its own.
				await service.touchFile(filePath, "fn main() {}\n", {
					diagnostics: "none",
					clientScope,
					source: "dispatch",
				});
				expect(
					lines().some((line) => line.startsWith("recv workspace/symbol")),
				).toBe(false);
			}
			const turn = new AbortController();
			const touch = bounded(
				() =>
					service.touchFile(filePath, "fn main() {}\n", {
						diagnostics: "document",
						collectDiagnostics: true,
						clientScope,
						source: "dispatch",
					}),
				{
					ms: 20_000,
					signal: turn.signal,
					hook: "turn_end",
					label: "ambient-5097",
				},
			);
			await received("workspace/symbol");
			const abortedAt = Date.now();
			turn.abort();
			await expect(touch).resolves.toBeUndefined();
			await cancelledWithin500ms(abortedAt);
		},
		20_000,
	);

	/**
	 * The with-auxiliary per-edit gate on a real wire: a silent-on-clean primary
	 * (`lua`) and an auxiliary (`typos`) that never answers, so every touch is
	 * `partial` and none primes the service's last-known cache. `finding` makes
	 * the primary publish one finding on `didOpen` and nothing on `didChange`.
	 */
	function registerWithSilentAuxiliary(finding: boolean): string {
		const filePath = path.join(tmp, "main.fkr");
		fs.writeFileSync(filePath, "fn main() {}\n");
		const fake = (id: string, env: Record<string, string>) => ({
			id,
			name: id,
			extensions: [".fkr"],
			idleEviction: "resident",
			...(id === "typos" && { role: "auxiliary" }),
			root: async () => tmp,
			spawn: async () => {
				const proc = await spawnFakeLspServer({
					cwd: tmp,
					env: {
						...process.env,
						FAKE_LSP_NO_DIAGNOSTIC_PROVIDER: "1",
						...env,
					},
				});
				procs.push(proc);
				return { process: proc, source: "test" };
			},
		});
		const servers = [
			fake("lua", {
				FAKE_LSP_TRACE_FILE: trace,
				...(finding && { FAKE_LSP_PUSH_DIAGNOSTIC: "1" }),
			}),
			fake("typos", {}),
		];
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".fkr") ? servers : [],
		);
		return filePath;
	}
	const perEdit = {
		diagnostics: "document",
		collectDiagnostics: true,
		clientScope: "with-auxiliary",
		auxiliaryServerIds: ["typos"],
		source: "dispatch-lsp-runner",
	} as const;

	// Recurrence (#5775 review F1): the gate read "no known finding" from the
	// service's last-known cache, which a partial touch never primes. The primary's
	// finding from touch one was therefore forgotten, and its silence on the next
	// edit was certified clean while the auxiliary gap stayed named.
	it("a primary finding seen on a partial touch keeps the next silent edits unconfirmed", async () => {
		const filePath = registerWithSilentAuxiliary(true);
		const first = await service.touchFile(filePath, "fn main() {}\n", perEdit);
		expect(first?.diags.map((d) => d.code)).toEqual(["P2780"]);
		expect(first?.confirmation).toBe("partial");
		// Two later edits the primary never answers: the second one proves the
		// refusal is not spent by the first.
		for (const content of ["fn main() { }\n", "fn main() {  }\n"]) {
			const next = await service.touchFile(filePath, content, perEdit);
			expect(next?.inconclusive).toBe(true);
			expect(next?.inconclusiveServerIds).toEqual(["lua"]);
			expect(next?.confirmation).toBeUndefined();
		}
	}, 20_000);

	// The control for the case above: the same wire with no finding confirms the
	// warm edit, so the refusal above is the finding's and not the harness's.
	it("a silent-on-clean primary that never published is confirmed on the warm edit", async () => {
		const filePath = registerWithSilentAuxiliary(false);
		const cold = await service.touchFile(filePath, "fn main() {}\n", perEdit);
		expect(cold?.inconclusive).toBe(true);
		const warm = await service.touchFile(filePath, "fn main() { }\n", perEdit);
		expect(warm?.inconclusive).toBeUndefined();
		expect(warm?.diags).toEqual([]);
		expect(warm?.confirmation).toBe("partial");
		expect(warm?.unconfirmedServerIds).toEqual(["typos"]);
	}, 20_000);

	// Recurrence: reading the ambient abort in the pull makes every caller of the
	// pull a reader of whatever scope it inherited. A server-initiated re-pull
	// (`workspace/diagnostic/refresh`) runs in the context the server's stream was
	// created in, so a server first started by a tool call carried that call's
	// scope for the rest of the session, and one Esc in that turn silenced every
	// refresh re-pull after it (#5097, the "H2" gap the first PR accepted).
	it("a server started inside an aborted tool call still re-pulls on its own refresh", async () => {
		const filePath = path.join(tmp, "a.ts");
		fs.writeFileSync(filePath, "function greet() {}\n");
		fs.writeFileSync(path.join(tmp, "package.json"), "{}");
		const call = new AbortController();
		const { proc, client } = await spawnAbortScope.run(
			call.signal,
			async () => {
				const spawned = await spawnFakeLspServer({
					cwd: tmp,
					env: {
						...process.env,
						FAKE_LSP_REFRESH_ON_OPEN: "1",
						FAKE_LSP_TRACE_FILE: trace,
					},
				});
				procs.push(spawned);
				return {
					proc: spawned,
					client: await createLSPClient({
						serverId: "fake",
						process: spawned,
						root: tmp,
					}),
				};
			},
		);
		try {
			// The Esc that ended the call that started the server.
			call.abort();
			// Outside the scope, as every later touch is.
			await client.notify.open(filePath, "function greet() {}\n", "typescript");
			await received("textDocument/diagnostic");
		} finally {
			await client.shutdown().catch(() => {});
			await stopLSP(proc).catch(() => {});
		}
	}, 20_000);

	// Recurrence (#5654 review F1): the abort branch returned `unavailable` and the
	// wait fell through to its retry loop and the whole push-wait budget, so an Esc
	// during a pull a HEALTHY server was still answering ran the touch out to its
	// budget and wrote an `lsp-diagnostics-timeout` ledger row and a latency row for
	// a bound that never lapsed. An abort is a transition of its own: the touch
	// ends at once, reads inconclusive with no confirmation, and records no timeout.
	it("Esc during a pull a healthy server is still answering ends the touch at once with no timeout row", async () => {
		const filePath = register("", "fake-rust", {
			FAKE_LSP_DELAY_FIRST_PULL: "1",
			FAKE_LSP_DELAY_AFTER_FIRST_PULL_MS: "800",
		});
		const turn = new AbortController();
		const touch = spawnAbortScope.run(turn.signal, () =>
			service.touchFile(filePath, "fn main() {}\n", {
				diagnostics: "document",
				collectDiagnostics: true,
				clientScope: "primary",
				source: "dispatch",
			}),
		);
		await received("textDocument/diagnostic");
		const abortedAt = Date.now();
		turn.abort();
		const result = await touch;
		// The server would answer 800 ms after the pull reached it, and the
		// unguarded wait ran 1.7 s past the abort; the retry loop's own 250 ms
		// budget is all that may remain.
		expect(Date.now() - abortedAt).toBeLessThan(900);
		expect(result?.inconclusive).toBe(true);
		expect(result?.confirmation).toBeUndefined();
		expect(
			getDegradationSummary().filter(
				(group) => group.kind === "lsp-diagnostics-timeout",
			),
		).toEqual([]);
		// Test mode keeps the last few phase rows in memory instead of the log file.
		expect(
			getRecentLoggedPhases().filter(
				(row) => row.phase === "lsp_diagnostics_timeout",
			),
		).toEqual([]);
	}, 20_000);

	// Recurrence (#5097): a pull held to the readiness a loading server announced
	// (#5487) waits for quiescence on its own listener and timer, which read no
	// abort, so an Esc left the wait to run out the touch's whole budget.
	it("Esc while a loading server holds the pull ends the wait at once", async () => {
		const filePath = path.join(tmp, "a.ts");
		fs.writeFileSync(filePath, "function greet() {}\n");
		fs.writeFileSync(path.join(tmp, "package.json"), "{}");
		const proc = await spawnFakeLspServer({
			cwd: tmp,
			env: {
				...process.env,
				FAKE_LSP_LOADING_MS: "6000",
				FAKE_LSP_TRACE_FILE: trace,
			},
		});
		procs.push(proc);
		const client = await createLSPClient({
			serverId: "fake",
			process: proc,
			root: tmp,
		});
		try {
			await client.notify.open(filePath, "function greet() {}\n", "typescript");
			await vi.waitFor(
				() => expect(client.readinessBlock?.()?.reason).toBe("server-loading"),
				{ timeout: 5000, interval: 10 },
			);
			const esc = new AbortController();
			const wait = spawnAbortScope.run(esc.signal, () =>
				client.waitForDiagnostics(filePath, 8000, { pullOnly: true }),
			);
			// Once the call has parked on the server's loading notice.
			setImmediate(() => esc.abort());
			const startedAt = Date.now();
			await expect(wait).resolves.toBe("deadline-expired");
			expect(Date.now() - startedAt).toBeLessThan(2000);
		} finally {
			await client.shutdown().catch(() => {});
			await stopLSP(proc).catch(() => {});
		}
	}, 20_000);

	// Recurrence (#5654 review F3): the refresh re-pull stepped out of the
	// AsyncLocalStorage scope only, so `getAmbientAbortSignal()` fell back to the
	// hook-level turn signal, and a server's own refresh re-pull in an aborted turn
	// sent nothing. The re-pull serves the document, whatever the turn did.
	it("a server's refresh re-pulls although the hook-level turn signal is aborted", async () => {
		const filePath = path.join(tmp, "a.ts");
		fs.writeFileSync(filePath, "function greet() {}\n");
		fs.writeFileSync(path.join(tmp, "package.json"), "{}");
		const proc = await spawnFakeLspServer({
			cwd: tmp,
			env: {
				...process.env,
				FAKE_LSP_REFRESH_ON_OPEN: "1",
				FAKE_LSP_TRACE_FILE: trace,
			},
		});
		procs.push(proc);
		const client = await createLSPClient({
			serverId: "fake",
			process: proc,
			root: tmp,
		});
		const turn = new AbortController();
		turn.abort();
		setAmbientAbortSignal(turn.signal);
		try {
			await client.notify.open(filePath, "function greet() {}\n", "typescript");
			await received("textDocument/diagnostic");
		} finally {
			setAmbientAbortSignal(undefined);
			await client.shutdown().catch(() => {});
			await stopLSP(proc).catch(() => {});
		}
	}, 20_000);

	// Recurrence: a warm-up that an Esc cut left the server absent from
	// `demonstratedReady`, and `ensureWarmForSweep` read that as "still cold" and
	// wrote the session's negative cache (#799), so every later sweep skipped the
	// server's whole group. The cut touch used to be able to finish in the
	// background and clear it; now that its pull is cancelled it cannot, so an
	// abort has to leave no verdict (#5097).
	// The two spellings of the one Esc: the sweep's own signal, and the call's
	// ambient scope (the only one a caller that passes no signal has).
	it.each([
		["the sweep's own signal", "option"],
		["the call's ambient scope", "scope"],
	] as const)(
		"a warm-up cut by Esc through %s is not remembered as a cold server",
		async (_name, channel) => {
			const filePath = register("textDocument/diagnostic");
			const esc = new AbortController();
			const warm =
				channel === "option"
					? service.ensureWarmForSweep(filePath, {
							timeoutMs: 6000,
							signal: esc.signal,
						})
					: spawnAbortScope.run(esc.signal, () =>
							service.ensureWarmForSweep(filePath, { timeoutMs: 6000 }),
						);
			await received("textDocument/diagnostic");
			esc.abort();
			await warm;
			expect(
				(service as unknown as { state: { demonstratedCold: Set<string> } })
					.state.demonstratedCold.size,
			).toBe(0);
		},
		30_000,
	);

	// Recurrence (#5097, the remainder after #5654): `runWorkspaceDiagnostics`'s
	// project-wide pull took only its own controller, so an Esc during a
	// `lens_diagnostics mode=full` sweep left the request on the server, and the
	// sweep waited out the pull's whole budget before it noticed.
	it("Esc during a sweep's workspace pull ends the sweep at once and cancels the pull", async () => {
		vi.stubEnv("PI_LENS_LSP_WORKSPACE_PULL", "1");
		vi.stubEnv("PI_LENS_LSP_WORKSPACE_PULL_MS", "6000");
		try {
			register("workspace/diagnostic", "fake-rust", {
				FAKE_LSP_WORKSPACE_DIAGNOSTICS: "1",
			});
			const esc = new AbortController();
			const sweep = spawnAbortScope.run(esc.signal, () =>
				service.runWorkspaceDiagnostics(tmp, { signal: esc.signal }),
			);
			await received("workspace/diagnostic");
			const abortedAt = Date.now();
			esc.abort();
			await sweep;
			expect(Date.now() - abortedAt).toBeLessThan(1500);
			await cancelledWithin500ms(abortedAt);
		} finally {
			vi.unstubAllEnvs();
		}
	}, 30_000);
});

describe("the workspace pull and the read-only probe read the tool call's abort (#5097)", () => {
	const pullsSent = (file: string): number => {
		const trace = path.join(path.dirname(file), "trace.log");
		return fs.existsSync(trace)
			? fs
					.readFileSync(trace, "utf-8")
					.split("\n")
					.filter((line) => line.startsWith("recv workspace/diagnostic")).length
			: 0;
	};
	const pullServer = { env: { FAKE_LSP_WORKSPACE_DIAGNOSTICS: "1" } };

	// Recurrence (#5097 remainder, last comment after #5654): the workspace pull
	// owned a private controller and read no abort, so an Esc left the request
	// on the server and the caller waiting out the pull's budget. The abort is
	// the timeout's transition without its records: tracked as abandoned (a
	// repeat pull must not stack behind a server that ignored the cancel), no
	// timeout row, no failure-history row, and never a clean report.
	it("Esc during a workspace pull the server never answers returns at once, cancels it and records no timeout", async () => {
		resetDegradationLedger();
		await withHangingServer(
			"workspace/diagnostic",
			async (ctx) => {
				const abort = new AbortController();
				const call = spawnAbortScope.run(abort.signal, () =>
					ctx.client.requestWorkspaceDiagnostics(5000),
				);
				await ctx.received("workspace/diagnostic");
				const abortedAt = Date.now();
				abort.abort();
				await expect(call).resolves.toBeUndefined();
				expect(Date.now() - abortedAt).toBeLessThan(500);
				await ctx.barrier();
				expect(ctx.cancels()).toBe(1);
				expect(ctx.client.getPullFailureHistory?.()).toEqual([]);
				expect(
					getDegradationSummary().filter(
						(group) => group.kind === "lsp-pull-diagnostic-timeout",
					),
				).toEqual([]);
				expect(
					getRecentLoggedPhases().filter(
						(row) => row.phase === "lsp_pull_diagnostic_timeout",
					),
				).toEqual([]);
				// The server ignored the cancel, so the request is still pending: a
				// pull outside any scope must not send a second one behind it.
				await expect(
					ctx.client.requestWorkspaceDiagnostics(5000),
				).resolves.toBeUndefined();
				await ctx.barrier();
				expect(pullsSent(ctx.file)).toBe(1);
			},
			pullServer,
		);
	}, 20_000);

	it("a workspace pull begun under an aborted scope sends nothing", async () => {
		await withHangingServer(
			"workspace/diagnostic",
			async (ctx) => {
				const gone = new AbortController();
				gone.abort();
				await expect(
					spawnAbortScope.run(gone.signal, () =>
						ctx.client.requestWorkspaceDiagnostics(5000),
					),
				).resolves.toBeUndefined();
				await ctx.barrier();
				expect(pullsSent(ctx.file)).toBe(0);
				expect(ctx.cancels()).toBe(0);
			},
			pullServer,
		);
	}, 20_000);

	const projectInfo = (file: string): [string, unknown[]] => [
		"typescript.tsserverRequest",
		["projectInfo", { file, needFileNameList: false }],
	];
	const wedgedTsserver = {
		env: { FAKE_LSP_HANG_PROJECT_INFO: "1" },
		serverId: "typescript",
		launchVariant: "classic" as const,
		open: false,
	};

	// Recurrence (#5097 remainder): `runReadOnlyServerCommand` passed the sender
	// no signal, so an Esc left the read-only tsserver `projectInfo` request
	// pending until its 2.5 s probe ceiling, holding the busy count that keeps
	// `ClientRegistry` from evicting the client. An Esc is no degradation: no
	// `lsp-readonly-command-released` row, and `executed:false`, never a result.
	it("Esc during a read-only tsserver command returns at once, cancelled and released, with no released row", async () => {
		resetDegradationLedger();
		await withHangingServer(
			"",
			async (ctx) => {
				const abort = new AbortController();
				const call = spawnAbortScope.run(abort.signal, () =>
					ctx.client.executeReadOnlyCommand(...projectInfo(ctx.file)),
				);
				await ctx.received("workspace/executeCommand");
				const abortedAt = Date.now();
				abort.abort();
				const outcome = await call;
				expect(Date.now() - abortedAt).toBeLessThan(500);
				expect(outcome.executed).toBe(false);
				expect(ctx.client.isBusy?.()).toBe(false);
				await ctx.barrier();
				expect(ctx.cancels()).toBe(1);
				expect(
					getDegradationSummary().filter(
						(group) => group.kind === "lsp-readonly-command-released",
					),
				).toEqual([]);
			},
			wedgedTsserver,
		);
	}, 20_000);

	it("a read-only command begun under an aborted scope sends nothing", async () => {
		await withHangingServer(
			"",
			async (ctx) => {
				const gone = new AbortController();
				gone.abort();
				const outcome = await spawnAbortScope.run(gone.signal, () =>
					ctx.client.executeReadOnlyCommand(...projectInfo(ctx.file)),
				);
				expect(outcome.executed).toBe(false);
				await ctx.barrier();
				const trace = fs.readFileSync(
					path.join(path.dirname(ctx.file), "trace.log"),
					"utf-8",
				);
				expect(trace).not.toContain("recv workspace/executeCommand");
				expect(ctx.cancels()).toBe(0);
			},
			wedgedTsserver,
		);
	}, 20_000);

	// The production caller: the didOpen project-identity probe is detached from
	// the touch that opened the document, but runs in its scope. Esc ends it the
	// way it ends the touch: one cancel on the wire and the busy count released
	// (the probe's own latency row is kept out of the recent-phase ring).
	it("Esc after a touch opened a typescript document cancels its detached projectInfo probe", async () => {
		await withHangingServer(
			"",
			async (ctx) => {
				const abort = new AbortController();
				await spawnAbortScope.run(abort.signal, () =>
					ctx.client.notify.open(
						ctx.file,
						"function greet() {}\n",
						"typescript",
					),
				);
				await ctx.received("workspace/executeCommand");
				const abortedAt = Date.now();
				abort.abort();
				await vi.waitFor(() => expect(ctx.cancels()).toBe(1), {
					timeout: 500,
					interval: 10,
				});
				await vi.waitFor(() => expect(ctx.client.isBusy?.()).toBe(false), {
					timeout: 500,
					interval: 10,
				});
				expect(Date.now() - abortedAt).toBeLessThan(500);
			},
			wedgedTsserver,
		);
	}, 20_000);
});
