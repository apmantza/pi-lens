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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _setServersForFileForTests } from "../../clients/lsp/config.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { clearWidgetState } from "../../clients/widget-state.js";
import { waitFor } from "../clients/interleaving-kit.js";
import { removeTempDirSync } from "../clients/test-utils.js";
import { useGlobalConfig } from "../support/global-config.js";
import { installLspService } from "../support/lsp-service-seam.js";

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
const realSetTimeout = globalThis.setTimeout;

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
 * `Infinity` is a server that never publishes.
 */
function makeFakeServer(
	root: string,
	publishAtMs: number,
	serverId: string,
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
		shutdown: async () => {},
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none",
		}),
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
				new Promise<undefined>((resolve) => {
					budgets.push(ms);
					const publishes = ms >= publishAtMs;
					setTimeout(
						() => {
							if (publishes) {
								version += 1;
								stampsByPath.set(filePath, version);
								cache.set(normalizeMapKey(filePath), {
									diags: [FINDING],
									ts: Date.now(),
								});
							}
							resolve(undefined);
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

/**
 * Run the real tool and drive the fake clock until it answers, so a wait of any
 * length costs no wall time. Each step also yields a real millisecond, so the
 * tool's real I/O can finish before the fake wait it precedes is advanced.
 */
async function runTool(
	args: Record<string, unknown>,
	cwd: string,
): Promise<any> {
	const { createLspDiagnosticsTool } =
		await import("../../tools/lsp-diagnostics.js");
	let settled = false;
	const call = createLspDiagnosticsTool()
		.execute("diag-5306", args, new AbortController().signal, null, { cwd })
		.finally(() => {
			settled = true;
		});
	// The deadline is on the fake clock too (`Date` is faked), so it is sized in
	// fake milliseconds: well past the 30 s cap this file measures.
	await waitFor(
		() => settled,
		(done) => done,
		{
			timeoutMs: 120_000,
			yieldControl: async () => {
				await vi.advanceTimersByTimeAsync(250);
				await new Promise<void>((resolve) => realSetTimeout(resolve, 1));
			},
		},
	);
	return (await call) as any;
}

/** A C++ file of `lines` lines (the trailing newline adds none). */
function cppLines(lines: number): string {
	return "int x;\n".repeat(lines - 1) + "int y;";
}

describe("#5306 explicit single-file lens_diagnostics query", () => {
	let tmp: string;
	let service: unknown;
	let server: FakeServer;
	const setGlobalConfig = useGlobalConfig();

	function useServer(publishAtMs: number, lang: Lang = CLANGD): void {
		server = makeFakeServer(tmp, publishAtMs, lang.id);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(lang.ext)
				? [
						{
							id: lang.id,
							name: lang.id,
							extensions: [lang.ext],
							root: async () => tmp,
							spawn: vi.fn(async () => ({ process: {}, source: "test" })),
						},
					]
				: [],
		);
		createLSPClient.mockImplementation(async () => server.client);
	}

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
		await (service as { destroy?: () => Promise<void> })?.destroy?.();
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
});
