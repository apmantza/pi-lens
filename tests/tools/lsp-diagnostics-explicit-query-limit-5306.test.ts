// flake-shape: service-double — #5306: a language server is a spawned process, and this file's subject
// is that it needs ~3 s to publish while the service's wait budget is the thing under test, which no
// real server can be asked to do on demand without a real 3 s wait
// flake-shape: in-process-mock — only the language-server client stands in; the service, the touch's
// per-server wait resolution, the content bound, the config loaders and the tool are the real production code
/**
 * #5306: the explicit single-file `lens_diagnostics source=lsp` query has its
 * own line limit (a trusted GLOBAL config key) and an explicit `waitMs` that is
 * no longer shrunk back to the per-server aggregate wait.
 *
 * Recurrence this file prevents: a 10,034-line C++ file could be neither
 * queried (the shared 5000-line bound refused it) nor waited for (`waitMs=120000`
 * still returned "check timed out" at 1510 ms, because the touch resolved
 * `min(waitMs, aggregateWaitMs)` while clangd needed ~5.6 s). The two fixes
 * only mean something together, and each must leave the other paths alone.
 *
 * The real `LSPService` is wired to the real tool; only the server registry and
 * the client transport are faked (the `lsp-diagnostics-silent-clean-flow`
 * seam). The fake server is production-faithful on the axis under test: it
 * receives the budget the service hands `waitForDiagnostics`, and it publishes
 * only when that budget reaches its own publish time, so a wait the service
 * shrinks to 1500 ms cannot see a server that needs 3000 ms. It records every
 * budget and every document it is sent, so the assertions read what reached the
 * server, not what the tool printed.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { _setServersForFileForTests } from "../../clients/lsp/config.js";
import type { LSPService } from "../../clients/lsp/index.js";
import {
	_resetLspBudgetDecisionForTests,
	checkCrossProcessLspBudget,
} from "../../clients/lsp-budget.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { clearWidgetState } from "../../clients/widget-state.js";
import { waitFor } from "../clients/interleaving-kit.js";
import { removeTempDirSync } from "../clients/test-utils.js";
import { useGlobalConfig } from "../support/global-config.js";
import { installLspService } from "../support/lsp-service-seam.js";
import { scaledTestTimeout } from "../support/test-timeout-scale.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../clients/lsp/client.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../clients/lsp/client.js")
	>("../../clients/lsp/client.js");
	return { ...actual, createLSPClient };
});

// The tool also awaits REAL I/O (stat, read, the drift sweep) before the fake
// server's wait begins; the driver below yields to it through this real timer.
// The real clock is captured here, before `vi.useFakeTimers()` replaces `Date`:
// the driver's deadline is real time (defect shape 86), the server's is fake.
const realSetTimeout = globalThis.setTimeout;
const realNow = Date.now.bind(Date);

// Module scope (not only `beforeEach`): the fake server's wait is a timer on the
// FAKE clock, which is what lets a 30 s cap be measured in microseconds, and the
// flake-shape scan reads the activation line-ordered.
vi.useFakeTimers();

/** The cpp server's publish time, past clangd's 1500 ms aggregate wait. */
const PUBLISH_AT_MS = 3000;
/** The language a fake server speaks: its registry id and its file extension. */
interface Lang {
	id: string;
	ext: string;
}
const CLANGD: Lang = { id: "clangd", ext: ".cpp" };
/** lua is push-only and `silentOnClean` (wait-policy/strategies.ts). */
const LUA: Lang = { id: "lua", ext: ".lua" };
/** rust-analyzer is pull-capable (wait-policy/strategies.ts, 3000 ms aggregate). */
const RUST: Lang = { id: "rust-analyzer", ext: ".rs" };
/** The real client's pull request cap (`PULL_REQUEST_TIMEOUT_MS`, client.ts). */
const PULL_CAP_MS = 10_000;
const FINDING = {
	severity: 1 as const,
	message: "use of undeclared identifier 'undefined_marker_a'",
	range: {
		start: { line: 4, character: 0 },
		end: { line: 4, character: 5 },
	},
	source: "clangd",
};

interface FakeServer {
	client: Record<string, unknown>;
	/** Every budget the service handed `waitForDiagnostics`. */
	budgets: number[];
	/** Every document the service sent via `notify.open`. */
	opened: string[];
}

/**
 * A push server that publishes `FINDING` once it is given a wait of at least
 * `publishAtMs`, and says nothing for a shorter one. `publishAtMs` of
 * `Infinity` is a server that never publishes; `publishAtMs` of 0 publishes an
 * empty answer at once (a scanner that found nothing). Like the real client
 * (`clientWaitForDiagnostics`), the wait returns "answered" when it published
 * and "deadline-expired" when its budget ran out with nothing stored.
 *
 * With `pullOnlyStopsAtMs` the server is pull-capable and models the real
 * client's `pullOnly` contract (`clientWaitForDiagnostics`): the pull request
 * stops at its own cap whatever budget it was given, and a pull that got no
 * reply returns "deadline-expired" having stored nothing.
 */
function makeFakeServer(
	root: string,
	publishAtMs: number,
	serverId: string,
	pullOnlyStopsAtMs?: number,
): FakeServer {
	const budgets: number[] = [];
	const opened: string[] = [];
	let version = 0;
	const stampsByPath = new Map<string, number>();
	const cache = new Map<string, { diags: unknown[]; ts: number }>();
	const client = {
		get diagnosticsVersion() {
			return version;
		},
		getDiagnosticsVersionForPath: vi.fn(
			(filePath: string) => stampsByPath.get(filePath) ?? 0,
		),
		isAlive: () => true,
		shutdown: vi.fn(async () => {}),
		getWorkspaceDiagnosticsSupport: () =>
			pullOnlyStopsAtMs === undefined
				? {
						advertised: false,
						mode: "push-only" as const,
						diagnosticProviderKind: "none",
					}
				: {
						advertised: true,
						mode: "pull" as const,
						diagnosticProviderKind: "object",
					},
		getOperationSupport: () => ({}),
		getAdvertisedCommands: () => [],
		getRawCapabilityKeys: () => [],
		getLaunchVariant: () => undefined,
		serverId,
		root,
		notify: {
			announceCreated: () => undefined,
			open: vi.fn(async (filePath: string, content: string) => {
				opened.push(content);
				cache.delete(normalizeMapKey(filePath));
			}),
		},
		waitForDiagnostics: vi.fn(
			(filePath: string, ms: number) =>
				new Promise<"answered" | "deadline-expired">((resolve) => {
					budgets.push(ms);
					if (pullOnlyStopsAtMs !== undefined) {
						setTimeout(
							() => resolve("deadline-expired"),
							Math.min(ms, pullOnlyStopsAtMs),
						);
						return;
					}
					const publishes = ms >= publishAtMs;
					setTimeout(
						() => {
							if (publishes) {
								version += 1;
								stampsByPath.set(filePath, version);
								cache.set(normalizeMapKey(filePath), {
									diags: publishAtMs === 0 ? [] : [FINDING],
									ts: Date.now(),
								});
							}
							resolve(publishes ? "answered" : "deadline-expired");
						},
						publishes ? publishAtMs : ms,
					);
				}),
		),
		getDiagnostics: vi.fn(
			(filePath: string) => cache.get(normalizeMapKey(filePath))?.diags ?? [],
		),
		getAllDiagnostics: vi.fn(() => cache),
	};
	return { client, budgets, opened };
}

/** Real milliseconds the driver gives the tool's real I/O, before the scale. */
const DRIVER_DEADLINE_MS = 20_000;

/**
 * Run the real tool and drive the fake clock until it answers, so a wait of any
 * length costs no wall time. Each step also yields a real millisecond, so the
 * tool's real I/O can finish before the fake wait it precedes is advanced.
 *
 * The driver's deadline is a REAL-clock one (`PI_LENS_TEST_TIMEOUT_SCALE`
 * scaled), separate from the server's fake clock: `waitFor` reads `Date.now()`,
 * which is faked here and moves 250 ms per pass, so its own deadline would count
 * passes and run out on a slow disk while the tool is still doing valid work.
 * Recurrence this prevents: PR #5318 thread PRRT_kwDORt8rec60OLnx (shape 86).
 */
async function runTool(
	args: Record<string, unknown>,
	cwd: string,
): Promise<any> {
	const { createLspDiagnosticsTool } =
		await import("../../tools/lsp-diagnostics.js");
	return drive(
		createLspDiagnosticsTool().execute(
			"diag-5306",
			args,
			new AbortController().signal,
			null,
			{ cwd },
		),
	);
}

/** Drive the fake clock until `pending` settles (see `runTool`). */
async function drive<T>(pending: Promise<T>): Promise<T> {
	let settled = false;
	const call = pending.finally(() => {
		settled = true;
	});
	const realDeadline = realNow() + scaledTestTimeout(DRIVER_DEADLINE_MS);
	const state = await waitFor(
		() =>
			settled
				? "settled"
				: realNow() >= realDeadline
					? "real-deadline-passed"
					: "pending",
		(value) => value !== "pending",
		{
			// Only the real deadline above ends the wait; this fake-clock budget is
			// unreachable (250 ms per pass).
			timeoutMs: Number.MAX_SAFE_INTEGER / 4,
			yieldControl: async () => {
				await vi.advanceTimersByTimeAsync(250);
				await new Promise<void>((resolve) => realSetTimeout(resolve, 1));
			},
		},
	);
	expect(state, "the call answered before the real-clock deadline").toBe(
		"settled",
	);
	return call;
}

/** A C++ file of `lines` lines (the trailing newline adds none). */
function cppLines(lines: number): string {
	return "int x;\n".repeat(lines - 1) + "int y;";
}

describe("#5306 explicit single-file lens_diagnostics query", () => {
	let tmp: string;
	let service: LSPService;
	let server: FakeServer;
	const setGlobalConfig = useGlobalConfig();

	function useServer(
		publishAtMs: number,
		lang: Lang = CLANGD,
		pullOnlyStopsAtMs?: number,
	): void {
		useServers(publishAtMs, lang, [], pullOnlyStopsAtMs);
	}

	/** The primary `lang` server plus auxiliary scanners on the same file. */
	function useServers(
		publishAtMs: number,
		lang: Lang,
		auxiliaries: Array<{ id: string; publishAtMs: number }>,
		pullOnlyStopsAtMs?: number,
	): Map<string, FakeServer> {
		server = makeFakeServer(tmp, publishAtMs, lang.id, pullOnlyStopsAtMs);
		const fakes = new Map([[lang.id, server]]);
		for (const aux of auxiliaries) {
			fakes.set(aux.id, makeFakeServer(tmp, aux.publishAtMs, aux.id));
		}
		const entries = [
			{ id: lang.id },
			...auxiliaries.map((aux) => ({ id: aux.id, role: "auxiliary" })),
		].map((entry) => ({
			...entry,
			name: entry.id,
			extensions: [lang.ext],
			root: async () => tmp,
			spawn: vi.fn(async () => ({ process: {}, source: "test" })),
		}));
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(lang.ext) ? entries : [],
		);
		createLSPClient.mockImplementation(
			async (options: { serverId: string }) =>
				fakes.get(options.serverId)?.client,
		);
		return fakes;
	}

	async function underPressure(): Promise<void> {
		const previous = process.env.PI_LENS_LSP_BUDGET_CEILING;
		process.env.PI_LENS_LSP_BUDGET_CEILING = "1";
		try {
			await checkCrossProcessLspBudget({
				registry: [
					{
						pid: 42,
						startedAt: new Date().toISOString(),
						projectRoot: tmp,
						lspChildren: [
							{
								pid: 43,
								serverId: "rust-analyzer",
								command: "rust-analyzer",
								spawnedAt: new Date().toISOString(),
							},
						],
						lspChildCount: 1,
						rssBytes: 1,
						heartbeatAt: new Date().toISOString(),
					},
				],
				isPidAlive: () => true,
			});
		} finally {
			if (previous === undefined) {
				delete process.env.PI_LENS_LSP_BUDGET_CEILING;
			} else {
				process.env.PI_LENS_LSP_BUDGET_CEILING = previous;
			}
		}
	}

	// The test budget sits above the driver's real deadline, so a stuck tool reds
	// as the driver's named failure rather than as a bare vitest timeout.
	beforeAll(() => {
		vi.setConfig({
			testTimeout: scaledTestTimeout(DRIVER_DEADLINE_MS + 10_000),
		});
	});

	beforeEach(async () => {
		_setServersForFileForTests(getServersForFileWithConfig);
		clearWidgetState();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5306-"));
		const { LSPService } = await import("../../clients/lsp/index.js");
		service = installLspService(new LSPService());
	});

	afterEach(async () => {
		clearWidgetState();
		_resetLspBudgetDecisionForTests();
		const spawnedAClient = createLSPClient.mock.calls.length > 0;
		await service.shutdown();
		// The service really closed what it opened (PR #5318 thread
		// PRRT_kwDORt8rec60OLn3: the old cast `destroy()` was a silent no-op).
		if (spawnedAClient) {
			expect(server.client.shutdown).toHaveBeenCalled();
		}
		removeTempDirSync(tmp);
	});

	describe("line limit", () => {
		it("skips an 8k-line file at the default limit and never sends it to the server", async () => {
			useServer(PUBLISH_AT_MS);
			const file = path.join(tmp, "big.cpp");
			fs.writeFileSync(file, cppLines(8000));

			const result = await runTool({ path: file, waitMs: 10_000 }, tmp);

			expect(result.details.outcome).toBe("too_large");
			expect(result.content[0].text).toContain("8000 lines > 5000 limit");
			expect(server.opened).toEqual([]);
			// A skipped file never reads as clean.
			expect(result.content[0].text).not.toMatch(/confirmed clean/i);
		});

		it("names the global config key an over-limit single-file query can use", async () => {
			useServer(PUBLISH_AT_MS);
			const file = path.join(tmp, "big.cpp");
			fs.writeFileSync(file, cppLines(8000));

			const result = await runTool({ path: file }, tmp);

			expect(result.content[0].text).toContain("lsp.queryMaxFileLines");
		});

		it("sends the same file to the server when the GLOBAL key is 20000", async () => {
			setGlobalConfig({ lsp: { queryMaxFileLines: 20_000 } });
			useServer(PUBLISH_AT_MS);
			const file = path.join(tmp, "big.cpp");
			const content = cppLines(8000);
			fs.writeFileSync(file, content);

			const result = await runTool({ path: file, waitMs: 10_000 }, tmp);

			expect(server.opened).toEqual([content]);
			expect(result.details.outcome).not.toBe("too_large");
			expect(result.details.totalDiagnostics).toBe(1);
		});

		it("still refuses a file past the configured limit", async () => {
			setGlobalConfig({ lsp: { queryMaxFileLines: 20_000 } });
			useServer(PUBLISH_AT_MS);
			const file = path.join(tmp, "huge.cpp");
			fs.writeFileSync(file, cppLines(20_001));

			const result = await runTool({ path: file, waitMs: 10_000 }, tmp);

			expect(result.details.outcome).toBe("too_large");
			expect(result.content[0].text).toContain("20001 lines > 20000 limit");
			expect(server.opened).toEqual([]);
		});

		it("keeps the 5000-line limit for a batch query even with the key set", async () => {
			setGlobalConfig({ lsp: { queryMaxFileLines: 20_000 } });
			useServer(PUBLISH_AT_MS);
			const file = path.join(tmp, "big.cpp");
			fs.writeFileSync(file, cppLines(8000));

			const result = await runTool({ paths: [file], waitMs: 10_000 }, tmp);

			expect(result.details.outcomeCounts.too_large).toBe(1);
			expect(result.details.cleanFiles).toBe(0);
		});
	});

	describe("waitMs", () => {
		it("honours a waitMs above the 1500 ms aggregate: a server publishing at ~3 s answers", async () => {
			useServer(PUBLISH_AT_MS);
			const file = path.join(tmp, "small.cpp");
			fs.writeFileSync(file, cppLines(50));

			const result = await runTool({ path: file, waitMs: 4000 }, tmp);

			expect(server.budgets).toEqual([4000]);
			expect(result.details.totalDiagnostics).toBe(1);
			expect(result.content[0].text).not.toMatch(/timed out/i);
		});

		it("caps an enormous waitMs at 30000 ms", async () => {
			useServer(Number.POSITIVE_INFINITY);
			const file = path.join(tmp, "small.cpp");
			fs.writeFileSync(file, cppLines(50));

			await runTool({ path: file, waitMs: 120_000 }, tmp);

			expect(server.budgets).toEqual([30_000]);
		});

		it("keeps a waitMs below the aggregate as a floor: the 1500 ms aggregate still runs", async () => {
			useServer(Number.POSITIVE_INFINITY);
			const file = path.join(tmp, "small.cpp");
			fs.writeFileSync(file, cppLines(50));

			await runTool({ path: file, waitMs: 500 }, tmp);

			expect(server.budgets).toEqual([1500]);
		});

		it("does not read a silent-on-clean server as clean when waitMs is below its aggregate", async () => {
			// lua is push-only and silent on clean, so a wait that times out reads as
			// confirmed clean. A short waitMs must not shorten its 2000 ms aggregate:
			// the finding it publishes at 1000 ms would otherwise read as clean.
			useServer(1000, LUA);
			const file = path.join(tmp, "small.lua");
			fs.writeFileSync(file, cppLines(50));

			const result = await runTool({ path: file, waitMs: 100 }, tmp);

			expect(result.content[0].text).not.toMatch(/confirmed clean/i);
			expect(server.budgets).toEqual([2000]);
			expect(result.details.totalDiagnostics).toBe(1);
		});

		it("leaves the per-server aggregate wait alone when no waitMs is given", async () => {
			useServer(PUBLISH_AT_MS);
			const file = path.join(tmp, "small.cpp");
			fs.writeFileSync(file, cppLines(50));

			const result = await runTool({ path: file }, tmp);

			expect(server.budgets).toEqual([1500]);
			// The server needed 3000 ms; the answer is a timeout, never a clean file.
			expect(result.content[0].text).toContain("check timed out");
			expect(result.content[0].text).toContain("NOT the same as 0 diagnostics");
			expect(result.content[0].text).not.toMatch(/confirmed clean/i);
		});

		it("does not widen a batch query's wait", async () => {
			useServer(PUBLISH_AT_MS);
			const file = path.join(tmp, "small.cpp");
			fs.writeFileSync(file, cppLines(50));

			const result = await runTool({ paths: [file], waitMs: 4000 }, tmp);

			// The batch's own pre-sweep warm-up asks for 20 s; the file's touch gets
			// the aggregate, and no budget is the caller's 4000.
			expect(server.budgets).not.toContain(4000);
			expect(server.budgets.at(-1)).toBe(1500);
			expect(result.details.cleanFiles).toBe(0);
		});

		it("a wait that still times out reads as timed out, never clean, and its text is true", async () => {
			useServer(Number.POSITIVE_INFINITY);
			const file = path.join(tmp, "small.cpp");
			fs.writeFileSync(file, cppLines(50));

			const result = await runTool({ path: file, waitMs: 2000 }, tmp);

			const text: string = result.content[0].text;
			expect(text).toContain("check timed out");
			expect(text).not.toMatch(/confirmed clean/i);
			// The old advice ("increase waitMs") was false for this scope; the
			// corrected text states the real ceiling.
			expect(text).not.toContain("or increase waitMs");
			expect(text).toContain("30000");
		});
	});

	describe("a pull-only wait that expired", () => {
		// Recurrence this prevents: under machine-wide LSP pressure a pull-capable
		// server (rust-analyzer) is asked pullOnly. With waitMs=30000 the service
		// budget is 30 s while the pull request stops at 10 s and the client returns
		// "deadline-expired"; the touch judged timed-out from elapsed time alone
		// (10 s + 20 ms < 30 s), answered "confirmed", and the tool printed a clean
		// file for a check that never got an answer. PR #5318 review thread
		// PRRT_kwDORt8rec60OLnk.
		it("reads a pull that stopped at its own cap inside waitMs as timed out, never clean", async () => {
			await underPressure();
			useServer(Number.POSITIVE_INFINITY, RUST, PULL_CAP_MS);
			const file = path.join(tmp, "lib.rs");
			fs.writeFileSync(file, cppLines(50));

			const result = await runTool({ path: file, waitMs: 30_000 }, tmp);

			// The client was asked pullOnly with the caller's full budget, and
			// stopped at 10 s: the wait the service made ended well before 30 s.
			expect(server.budgets).toEqual([30_000]);
			const text: string = result.content[0].text;
			expect(text).toContain("check timed out");
			expect(text).not.toMatch(/confirmed clean/i);
			expect(result.details.outcome).not.toBe("clean");
		});
	});

	describe("the touch verdict after a wait that returned deadline-expired", () => {
		// PR #5318 r4 state table (caller x primary kind x wait outcome). Each
		// touch runs through the real `LSPService.touchFile` with the options its
		// production caller passes. A primary's wait that returned
		// "deadline-expired" is a timeout even when a larger budget beside it was
		// still running, unless the primary is silent-on-clean, whose silence is
		// its clean answer.
		// Recurrences: master read a lapsed clangd or a failed rust-analyzer pull
		// beside opengrep as confirmed clean (rows 7, 12, 14, 15, 18, 21), and the
		// r3 clause read a clean TypeScript, Markdown or Lua edit in the dispatch
		// runner as inconclusive (rows 16, 19; review r3 F6).
		const OPENGREP = { id: "opengrep", publishAtMs: 0 };
		const TYPOS_SILENT = {
			id: "typos",
			publishAtMs: Number.POSITIVE_INFINITY,
		};
		const NEVER = Number.POSITIVE_INFINITY;
		/** A rust-analyzer pull that failed (no reply) stops after its 500 ms retry budget. */
		const FAILED_PULL_MS = 500;
		const EXPLICIT = {
			diagnostics: "document",
			collectDiagnostics: true,
			explicitQuery: true,
			clientScope: "all",
			source: "lsp_diagnostics",
			saved: true,
		} as const;
		const BATCH = {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: "all",
			source: "lens_diagnostics_full",
		} as const;
		/** clients/dispatch/runners/lsp.ts's per-edit touch. */
		const DISPATCH = {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: "with-auxiliary",
			maxClientWaitMs: 5000,
			maxDiagnosticsWaitMs: 2500,
			source: "dispatch-lsp-runner",
		} as const;
		/** clients/dispatch/integration.ts's cascade touch. */
		const CASCADE = {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: "primary",
			maxClientWaitMs: 2000,
			source: "cascade",
		} as const;

		async function touch(
			lang: Lang,
			options: Record<string, unknown>,
		): Promise<any> {
			const file = path.join(tmp, `f${lang.ext}`);
			fs.writeFileSync(file, "x\n");
			return drive(service.touchFile(file, "x\n", options as any));
		}

		it("row 7: explicit query, clangd lapsed beside opengrep, reads timed out", async () => {
			const fakes = useServers(NEVER, CLANGD, [OPENGREP]);
			const result = await touch(CLANGD, EXPLICIT);
			expect(fakes.get("clangd")?.budgets).toEqual([1500]);
			expect(fakes.get("opengrep")?.budgets).toEqual([3500]);
			expect(result.inconclusive).toBe(true);
			expect(result.inconclusiveServerIds).toEqual(["clangd"]);
		});

		it("row 12: batch query, clangd lapsed beside opengrep, reads timed out", async () => {
			useServers(NEVER, CLANGD, [OPENGREP]);
			const result = await touch(CLANGD, BATCH);
			expect(result.inconclusive).toBe(true);
			expect(result.inconclusiveServerIds).toEqual(["clangd"]);
		});

		it("row 14: batch query, a failed rust-analyzer pull reads timed out", async () => {
			await underPressure();
			useServer(NEVER, RUST, FAILED_PULL_MS);
			const result = await touch(RUST, BATCH);
			expect(server.budgets).toEqual([3000]);
			expect(result.inconclusive).toBe(true);
			expect(result.inconclusiveServerIds).toEqual(["rust-analyzer"]);
		});

		it("row 15: dispatch runner, clangd lapsed beside opengrep, reads timed out", async () => {
			const fakes = useServers(NEVER, CLANGD, [OPENGREP]);
			const result = await touch(CLANGD, {
				...DISPATCH,
				auxiliaryServerIds: ["opengrep"],
			});
			expect(fakes.get("clangd")?.budgets).toEqual([1500]);
			expect(fakes.get("opengrep")?.budgets).toEqual([2500]);
			expect(result.inconclusive).toBe(true);
			expect(result.inconclusiveServerIds).toEqual(["clangd"]);
		});

		it.each([
			{ id: "typescript", ext: ".ts" },
			LUA,
			{ id: "marksman", ext: ".md" },
		])(
			"row 16: dispatch runner, a silent-on-clean $id beside opengrep reads clean",
			async (lang) => {
				useServers(NEVER, lang, [OPENGREP]);
				const result = await touch(lang, {
					...DISPATCH,
					auxiliaryServerIds: ["opengrep"],
				});
				expect(result.inconclusive).toBeFalsy();
				expect(result.diags).toEqual([]);
			},
		);

		it("row 18: dispatch runner, a failed rust-analyzer pull beside opengrep reads timed out", async () => {
			await underPressure();
			useServers(NEVER, RUST, [OPENGREP], FAILED_PULL_MS);
			const result = await touch(RUST, {
				...DISPATCH,
				auxiliaryServerIds: ["opengrep"],
			});
			expect(result.inconclusive).toBe(true);
			expect(result.inconclusiveServerIds).toEqual(["rust-analyzer"]);
		});

		it("row 19: dispatch runner, a lapsed auxiliary does not time out a silent-on-clean primary", async () => {
			const fakes = useServers(NEVER, { id: "typescript", ext: ".ts" }, [
				TYPOS_SILENT,
				OPENGREP,
			]);
			const result = await touch(
				{ id: "typescript", ext: ".ts" },
				{ ...DISPATCH, auxiliaryServerIds: ["typos", "opengrep"] },
			);
			// typos lapsed its 1500 ms inside opengrep's 2500 ms: a coverage gap,
			// not the touch's timeout.
			expect(fakes.get("typos")?.budgets).toEqual([1500]);
			expect(result.inconclusive).toBeFalsy();
		});

		it("row 21: cascade touch, a failed rust-analyzer pull reads timed out", async () => {
			await underPressure();
			useServer(NEVER, RUST, FAILED_PULL_MS);
			const result = await touch(RUST, CASCADE);
			expect(server.budgets).toEqual([2000]);
			expect(result.inconclusive).toBe(true);
			expect(result.inconclusiveServerIds).toEqual(["rust-analyzer"]);
		});
	});
});
