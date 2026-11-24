/**
 * A clean markdown edit pays the full silent-on-clean wait and is then reported
 * inconclusive, because the clean-confirm gate never covers the scope the
 * per-edit dispatch path actually uses.
 *
 * The real shape (`pi-lens` 4.5.2, `~/.pi-lens/latency.log` on a live session):
 *
 *   lsp_diagnostics_timeout  serverIds ["marksman","typos"] clientScope
 *                            "with-auxiliary" unansweredServerIds ["marksman"]
 *                            attributedToPrimary true
 *   lsp_touch_file           diagnosticsTimedOut true inconclusiveServerIds
 *                            ["marksman"] inconclusiveReason "diagnostics-wait"
 *
 * …and no `lsp_silent_clean_confirm` row at all, i.e. #799/#814's gates never
 * fire on that path. `typos` answered in 0ms; only marksman's legitimate
 * silence-on-clean kept the touch inconclusive, and `clients/dispatch` turns
 * that into "Markdown unconfirmed — not fully checked (a language tool is
 * missing, timed out, or failed to run)" on every markdown edit.
 *
 * Both existing gates require a scope the edit path does not use:
 *   - #799 (single-server): `clientScope === "primary"` — the edit path is
 *     `with-auxiliary` whenever any auxiliary is enabled for the language.
 *   - #814 (aggregate):    `clientScope === "all"` — the `lens_diagnostics`
 *     sweep path, not per-edit.
 * So the confirm is unreachable exactly where its cost is paid on every edit.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashDiagnosticContent } from "../../../clients/lsp/diagnostic-binding.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { removeTempDirSync } from "../test-utils.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

// Whole-module mock, like `silent-clean-confirm.test.ts`: the suite's ratchet
// (`tests/config/vi-mock-export-sweep.test.ts`, #2281) counts omitted module
// exports, so naming one member here would register a new regression row.
//
// The config module is mocked too, and the real one is NOT consulted: through
// the registry seam the production config reaches the real server list, whose
// rows probe for a launcher (`which`, `npm`, and the server itself) and start
// real child processes — which the #5100 real-spawn census refuses from a test
// with no admission. `getServerInitOverride` answers the one other member
// `LSPService` calls on this module.
vi.mock("../../../clients/lsp/client.js", () => ({ createLSPClient }));
vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

function makeServer(id: string, ext: string, root: string, role?: "auxiliary") {
	return {
		id,
		name: id,
		extensions: [ext],
		idleEviction: "resident" as const,
		...(role !== undefined && { role }),
		root: async () => root,
		spawn: vi.fn(async () => ({ process: {}, source: "test" })),
	};
}

/**
 * A push-only client that never publishes (a clean markdown file against
 * marksman). `answered` flips whether it answers at all: `true` mirrors a real
 * publisher that has nothing to report on a LATER touch, `false` the
 * silent-on-clean server this test is about.
 */
function makeSilentPushOnlyClient(serverId: string, root: string) {
	const sent = new Map<string, { hash: string }>();
	return {
		client: {
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
			getSentContent: (filePath: string) => sent.get(filePath),
			hasNotifyInFlight: () => false,
			notify: {
				open: vi.fn(async (filePath: string, content: string) => {
					sent.set(filePath, { hash: hashDiagnosticContent(content) });
				}),
			},
			waitForDiagnostics: vi.fn(async (_filePath: string, ms: number) => {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, ms);
					timer.unref?.();
				});
				return undefined;
			}),
			getDiagnostics: vi.fn(() => []),
			getAllDiagnostics: vi.fn(() => new Map()),
			pingLiveness: vi.fn().mockResolvedValue(true),
		},
	};
}

/**
 * A server that answers immediately with a confirmed empty set (typos on a
 * clean file). It is an ORDINARY push-only server — no `silentOnClean` marker —
 * which is what makes it the control: its answer must never be what licenses
 * calling marksman's silence clean.
 */
function makeAnsweringClient(serverId: string, root: string, filePath: string) {
	const sent = new Map<string, { hash: string }>();
	return {
		client: {
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
			getSentContent: (fp: string) => sent.get(fp),
			hasNotifyInFlight: () => false,
			notify: {
				open: vi.fn(async (fp: string, content: string) => {
					sent.set(fp, { hash: hashDiagnosticContent(content) });
				}),
			},
			waitForDiagnostics: vi.fn(async () => "answered" as const),
			getDiagnostics: vi.fn(() => []),
			// A present per-file entry is this touch's fresh answer: the notify above
			// clears the entry, so only a publication puts one back. The key must be
			// THE FILE's normalized path — the gate asks `has(normalizedPath)`, and a
			// placeholder key reads as "still outstanding" instead.
			getAllDiagnostics: vi.fn(
				() =>
					new Map([[normalizeMapKey(filePath), []]]) as unknown as Map<
						string,
						[]
					>,
			),
			pingLiveness: vi.fn().mockResolvedValue(true),
		},
	};
}

/**
 * A silent push-only client that ADVERTISES tsserver's sync command, which is
 * what makes the cascade class `command-pull` (typescript's shape). It never
 * publishes, so only the classification decides its verdict.
 */
function makeTsLikeSilentClient(serverId: string, root: string) {
	const base = makeSilentPushOnlyClient(serverId, root);
	return {
		...base.client,
		getAdvertisedCommands: () => ["typescript.tsserverRequest"],
	};
}

/**
 * A silent-on-clean client that reports ONE finding on its first touch and
 * nothing afterwards — the shape of a broken link the server has not
 * re-examined yet. It never publishes, so `lastKnownDiagnostics` is written by
 * the first touch's merged answer and the second touch's silence must not be
 * read as clean.
 */
function makePreviouslyDirtyClient(
	serverId: string,
	root: string,
	filePath: string,
) {
	const base = makeSilentPushOnlyClient(serverId, root);
	let touch = 0;
	const finding = {
		severity: 1 as const,
		message: "Link to non-existent document './gone.md'",
		range: {
			start: { line: 2, character: 0 },
			end: { line: 2, character: 20 },
		},
	};
	return {
		...base.client,
		// The FIRST touch answers, so the touch is decisive and primes the
		// last-known answer (an inconclusive touch deliberately does not).
		waitForDiagnostics: vi.fn(async (_f: string, ms: number) => {
			touch += 1;
			if (touch === 1) return "answered" as const;
			await new Promise<void>((resolve) => {
				const t = setTimeout(resolve, ms);
				t.unref?.();
			});
			return undefined;
		}),
		getDiagnostics: vi.fn(() => (touch === 1 ? [finding] : [])),
		getAllDiagnostics: vi.fn(
			() =>
				(touch === 1
					? new Map([[normalizeMapKey(filePath), [finding]]])
					: new Map()) as unknown as Map<string, []>,
		),
	};
}

describe("with-auxiliary silent-clean confirm (per-edit dispatch path)", () => {
	let tmp: string;
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-aux-silent-"));
		// Flat tiny budget: the mocked waits sleep in real time.
		process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS = "50";
	});
	afterEach(() => {
		delete process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS;
		removeTempDirSync(tmp);
	});

	it("a clean markdown edit with typos attached is CONFIRMED clean, not inconclusive", async () => {
		const filePath = path.join(tmp, "a.md");
		fs.writeFileSync(filePath, "# hi\n");
		const marksman = makeServer("marksman", ".md", tmp);
		const typos = makeServer("typos", ".md", tmp, "auxiliary");
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [marksman, typos] : [],
		);
		createLSPClient.mockImplementation(async (opts: { serverId: string }) =>
			opts.serverId === "typos"
				? makeAnsweringClient("typos", tmp, filePath).client
				: makeSilentPushOnlyClient("marksman", tmp).client,
		);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const options = {
			diagnostics: "document" as const,
			collectDiagnostics: true as const,
			clientScope: "with-auxiliary" as const,
			auxiliaryServerIds: ["typos"],
			source: "dispatch-lsp-runner",
		};

		// The touch that STARTS the client cannot confirm: its handshake runs ahead
		// of the document, so silence there is the spawn, not the file (measured at
		// 2.07 s cold against a 1500 ms budget).
		const cold = await service.touchFile(filePath, "# hi\n", options);
		expect((cold as { inconclusive?: boolean }).inconclusive).toBe(true);

		// The next edit inherits a live client, so its primary's silence IS the
		// answer. `partial` rather than `confirmed` because typos' lane answered
		// separately — asserting it pins the difference, so a regression to a
		// fully-confirmed touch cannot pass.
		const result = await service.touchFile(filePath, "# hi\n", options);
		expect(result?.diags).toHaveLength(0);
		expect(result?.confirmation).toBe("partial");
		expect((result as { inconclusive?: boolean }).inconclusive).toBeUndefined();
	});

	it("guards what the confirm must NOT absorb: a wedged silent primary stays inconclusive", async () => {
		const filePath = path.join(tmp, "b.md");
		fs.writeFileSync(filePath, "# hi\n");
		const marksman = makeServer("marksman", ".md", tmp);
		const typos = makeServer("typos", ".md", tmp, "auxiliary");
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [marksman, typos] : [],
		);
		const wedged = makeSilentPushOnlyClient("marksman", tmp);
		wedged.client.pingLiveness.mockResolvedValue(false);
		createLSPClient.mockImplementation(async (opts: { serverId: string }) =>
			opts.serverId === "typos"
				? makeAnsweringClient("typos", tmp, filePath).client
				: wedged.client,
		);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const result = await service.touchFile(filePath, "# hi\n", {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["typos"],
			source: "dispatch-lsp-runner",
		});

		expect((result as { inconclusive?: boolean }).inconclusive).toBe(true);
	});

	it("a liveness probe that THROWS stays inconclusive AND records the probe failure (#1277)", async () => {
		// The verdict must match a probe answering false, but "the check itself threw"
		// is a different fact from "the server is dead" and has to be visible in the
		// degradation ledger — otherwise a broken probe silently downgrades every
		// silent-on-clean edit to inconclusive with no trace of why.
		const filePath = path.join(tmp, "e.md");
		fs.writeFileSync(filePath, "# hi\n");
		const marksman = makeServer("marksman", ".md", tmp);
		const typos = makeServer("typos", ".md", tmp, "auxiliary");
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [marksman, typos] : [],
		);
		const broken = makeSilentPushOnlyClient("marksman", tmp);
		broken.client.pingLiveness.mockRejectedValue(new Error("probe exploded"));
		createLSPClient.mockImplementation(async (opts: { serverId: string }) =>
			opts.serverId === "typos"
				? makeAnsweringClient("typos", tmp, filePath).client
				: broken.client,
		);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const options = {
			diagnostics: "document" as const,
			collectDiagnostics: true as const,
			clientScope: "with-auxiliary" as const,
			auxiliaryServerIds: ["typos"],
			source: "dispatch-lsp-runner",
		};
		// Warm the client so this touch reaches the probe at all: a client the touch
		// starts is refused earlier, on the inherited-client check.
		await service.touchFile(filePath, "# hi\n", options);

		const result = await service.touchFile(filePath, "# hi\n", options);

		expect((result as { inconclusive?: boolean }).inconclusive).toBe(true);
		const { getDegradationSummary } =
			await import("../../../clients/degradation-ledger.js");
		expect(getDegradationSummary()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "lsp-liveness-probe-failed",
					latestReasons: expect.arrayContaining([
						expect.objectContaining({
							subject: "marksman",
							reason: expect.stringContaining("probe exploded"),
						}),
					]),
				}),
			]),
		);
	});

	it("guards what the confirm must NOT absorb: a TypeScript primary with a sync command stays inconclusive", async () => {
		// typescript carries the SAME `silentOnClean` marker as marksman, so a
		// capability-tier-only gate would confirm a still-loading TS project clean.
		// Its advertised `typescript.tsserverRequest` is what makes the cascade
		// classify it `command-pull` — silence that could still be ASKED — and that
		// class is what must keep this touch inconclusive on the per-edit path.
		const filePath = path.join(tmp, "d.ts");
		fs.writeFileSync(filePath, "const a = 1;\n");
		const typescript = makeServer("typescript", ".ts", tmp);
		const astGrep = makeServer("ast-grep", ".ts", tmp, "auxiliary");
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [typescript, astGrep] : [],
		);
		createLSPClient.mockImplementation(async (opts: { serverId: string }) =>
			opts.serverId === "typescript"
				? makeTsLikeSilentClient("typescript", tmp)
				: makeAnsweringClient("ast-grep", tmp, filePath).client,
		);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const result = await service.touchFile(filePath, "const a = 1;\n", {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["ast-grep"],
			source: "dispatch-lsp-runner",
		});

		expect((result as { inconclusive?: boolean }).inconclusive).toBe(true);
	});

	it("the other marked server (lua) is confirmed the same way — the fix is not markdown-specific", async () => {
		// `silentOnClean` is set on exactly three strategies (typescript, marksman,
		// lua). typescript is excluded by its command class and both remaining ones
		// are plain push-only servers, so this case is the fix's general shape on a
		// non-markdown language rather than a special case for the reported file.
		const filePath = path.join(tmp, "main.lua");
		fs.writeFileSync(filePath, "local value = 1\n");
		const lua = makeServer("lua", ".lua", tmp);
		const typos = makeServer("typos", ".lua", tmp, "auxiliary");
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".lua") ? [lua, typos] : [],
		);
		createLSPClient.mockImplementation(async (opts: { serverId: string }) =>
			opts.serverId === "typos"
				? makeAnsweringClient("typos", tmp, filePath).client
				: makeSilentPushOnlyClient("lua", tmp).client,
		);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const luaOptions = {
			diagnostics: "document" as const,
			collectDiagnostics: true as const,
			clientScope: "with-auxiliary" as const,
			auxiliaryServerIds: ["typos"],
			source: "dispatch-lsp-runner",
		};
		// Cold touch first: the client this one starts cannot confirm (its handshake
		// precedes the document). The second inherits a live client.
		await service.touchFile(filePath, "local value = 1\n", luaOptions);
		const result = await service.touchFile(
			filePath,
			"local value = 1\n",
			luaOptions,
		);

		expect(result?.diags).toHaveLength(0);
		expect((result as { inconclusive?: boolean }).inconclusive).toBeUndefined();
	});

	it("guards what the confirm must NOT absorb: an ordinary push-only primary straggler stays inconclusive", async () => {
		const filePath = path.join(tmp, "c.md");
		fs.writeFileSync(filePath, "# hi\n");
		// rust-analyzer-like: push-only, NO silentOnClean marker, publishes late.
		const raw = makeServer("rust-analyzer", ".md", tmp);
		const typos = makeServer("typos", ".md", tmp, "auxiliary");
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [raw, typos] : [],
		);
		createLSPClient.mockImplementation(async (opts: { serverId: string }) =>
			opts.serverId === "typos"
				? makeAnsweringClient("typos", tmp, filePath).client
				: makeSilentPushOnlyClient("rust-analyzer", tmp).client,
		);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const result = await service.touchFile(filePath, "# hi\n", {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["typos"],
			source: "dispatch-lsp-runner",
		});

		expect((result as { inconclusive?: boolean }).inconclusive).toBe(true);
	});

	it("a path whose last answer had findings never confirms on silence", async () => {
		// marksman withdraws findings by publishing an empty set, so silence on a
		// path that previously had one means it has not been re-examined — not that
		// it is clean. This is the case machine load produces: a finding delayed past
		// the budget (measured at 10.5 s under 14 competing CPU hogs).
		//
		// The last-known answer is primed by an AUTHORITATIVE touch (an inconclusive
		// or partial one deliberately does not prime), so this primes it with a
		// primary-scope touch and then asks the per-edit gate.
		const filePath = path.join(tmp, "g.md");
		fs.writeFileSync(filePath, "# hi\n\n[broken](./gone.md)\n");
		const marksman = makeServer("marksman", ".md", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [marksman] : [],
		);
		createLSPClient.mockImplementation(async () =>
			makePreviouslyDirtyClient("marksman", tmp, filePath),
		);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const priming = await service.touchFile(
			filePath,
			"# hi\n\n[broken](./gone.md)\n",
			{
				diagnostics: "document",
				collectDiagnostics: true,
				clientScope: "primary",
				source: "priming",
			},
		);
		expect(priming?.diags).toHaveLength(1);
		expect(service.getLastKnownDiagnostics(filePath)).toHaveLength(1);

		// The per-edit gate now sees silence on a path known to have had findings.
		const second = await service.touchFile(
			filePath,
			"# hi\n\n[broken](./gone.md)\n",
			{
				diagnostics: "document",
				collectDiagnostics: true,
				clientScope: "with-auxiliary",
				auxiliaryServerIds: [],
				source: "dispatch-lsp-runner",
			},
		);
		expect((second as { inconclusive?: boolean }).inconclusive).toBe(true);
	});
});
