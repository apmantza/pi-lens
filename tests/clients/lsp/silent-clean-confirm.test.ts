/**
 * #799: a push-only server marked `silentOnClean` (`wait-policy/strategies.ts`)
 * publishes NOTHING on a clean file — there is no pull fallback and (unlike
 * typescript's tsserver sync commands, `tsserver-sync.ts`) no active
 * sync-confirm protocol either, so a clean touch used to burn its FULL wait
 * budget with zero signal either way and get reported `inconclusive`
 * (`diagnosticsTimedOut`), never `demonstratedReady`.
 *
 * `touchFile`'s generic clean-confirm gate (`clients/lsp/index.ts`, next to
 * the tsserver-specific sync-confirm block) closes that gap: a single-server
 * primary-scope touch whose notify write succeeded, whose wait ran its full
 * budget with no publish, and whose live capability snapshot classifies as
 * `tier3-silent` (`classifyCascadeWaitTier`, #458 — push-only AND
 * `silentOnClean`) is now CONFIRMED clean, not inconclusive. These tests
 * exercise that gate directly via `touchFile`, using marksman's real
 * strategy (silentOnClean since #799) as the concrete example.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { removeTempDirSync } from "../test-utils.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../../clients/lsp/client.js", () => ({ createLSPClient }));

function makeServer(id: string, ext: string, root: string) {
	return {
		id,
		name: id,
		extensions: [ext],
		root: async () => root,
		spawn: vi.fn(async () => ({ process: {}, source: "test" })),
	};
}

/**
 * A push-only client that NEVER publishes diagnostics (mirrors a clean
 * markdown file against marksman) — `waitForDiagnostics` always resolves
 * `undefined` right at its deadline, exactly like a real client's wait
 * timing out with nothing having arrived.
 */
function makeSilentPushOnlyClient(serverId: string, root: string) {
	const waitCalls: Array<{ filePath: string; ms: number }> = [];
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
			notify: { open: vi.fn(async () => {}) },
			waitForDiagnostics: vi.fn(async (filePath: string, ms: number) => {
				waitCalls.push({ filePath, ms });
				await new Promise<void>((resolve) => {
					const t = setTimeout(resolve, ms);
					t.unref?.();
				});
				return undefined;
			}),
			getDiagnostics: vi.fn(() => []),
			// #814: never-publishes means nothing lands in the per-file cache
			// either — the aggregate gate's "still outstanding" check reads this
			// (`getAllDiagnostics().has(normalizedPath)`), same as the real
			// client's `clearDiagnosticsForPath`-then-nothing-arrived state.
			getAllDiagnostics: vi.fn(() => new Map()),
			// #1277: defaults to alive (matches the real client's "healthy
			// server" case, and `pingLiveness?.() ?? true`'s fallback for older
			// mocks that omit it entirely) — individual wedged-server tests
			// override this to `vi.fn().mockResolvedValue(false)`.
			pingLiveness: vi.fn().mockResolvedValue(true),
		},
		waitCalls,
	};
}

/**
 * #814: a server that DOES answer — either with real findings or a confirmed
 * empty result — resolving quickly regardless of the requested wait budget
 * (mirrors a fast push/pull confirmation, like `service-touch-collect.test.ts`'s
 * canned-resolve mocks). `getAllDiagnostics` reports a fresh per-file entry
 * (the same cache the real client clears on notify and repopulates on a real
 * publish/pull), which is exactly the "answered" signal the aggregate gate's
 * still-outstanding check relies on.
 */
function makePublishingClient(
	serverId: string,
	root: string,
	filePath: string,
	diagnostics: unknown[],
) {
	return {
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
		notify: { open: vi.fn(async () => {}) },
		waitForDiagnostics: vi.fn().mockResolvedValue(undefined),
		getDiagnostics: vi.fn(() => diagnostics),
		getAllDiagnostics: vi.fn(
			() =>
				new Map([
					[normalizeMapKey(filePath), { diags: diagnostics, ts: Date.now() }],
				]),
		),
	};
}

describe("touchFile silent-clean push-only confirm (#799)", () => {
	let tmp: string;
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-silent-clean-"));
		// Flat, tiny diagnostics-wait budget so the mocked servers' real
		// waitForDiagnostics sleep resolves in ~50ms instead of paying marksman's
		// real 1500ms strategy budget — keeps these tests fast without changing
		// the gate under test (readEnvDiagnosticsWaitMs, index.ts).
		process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS = "50";
	});
	afterEach(() => {
		delete process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS;
		removeTempDirSync(tmp);
	});

	it("(a) a silent-clean push-only server (marksman) resolves quickly as CONFIRMED clean (0 diagnostics), not inconclusive", async () => {
		const filePath = path.join(tmp, "a.md");
		fs.writeFileSync(filePath, "# hi\n");
		const marksman = makeServer("marksman", ".md", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [marksman] : [],
		);
		const { client, waitCalls } = makeSilentPushOnlyClient("marksman", tmp);
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const result = await service.touchFile(filePath, "# hi\n", {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: "primary",
			source: "test",
		});

		// Confirmed clean: an empty array, and NOT flagged inconclusive.
		expect(Array.isArray(result?.diags)).toBe(true);
		expect(result?.diags).toHaveLength(0);
		expect((result as { inconclusive?: boolean }).inconclusive).toBeUndefined();
		expect(result?.confirmation).toBe("confirmed");

		// The env override (set in beforeEach) is what the wait actually pays
		// here — marksman's real 1500ms strategy budget is covered separately by
		// sweep-warmup.test.ts:128.
		expect(waitCalls.length).toBe(1);
		expect(waitCalls[0]!.ms).toBe(50);

		// A confirmed-clean touch marks the server demonstratedReady — proven
		// indirectly via ensureWarmForSweep treating a subsequent sweep as a
		// no-op (this is the #799 fix that stops repeat-sweep re-payment).
		const warmup = await service.ensureWarmForSweep(filePath);
		expect(warmup.performedWarmup).toBe(false);
		expect(warmup.failedServerIds).toEqual([]);
	});

	it("#1277: a WEDGED marksman (accepts the notify write, then never answers anything) stays INCONCLUSIVE, not confirmed clean", async () => {
		const filePath = path.join(tmp, "a.md");
		fs.writeFileSync(filePath, "# hi\n");
		const marksman = makeServer("marksman", ".md", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [marksman] : [],
		);
		const { client } = makeSilentPushOnlyClient("marksman", tmp);
		// The notify write is accepted (resolves normally) and the capability
		// snapshot still classifies this touch as tier3-silent — identical to
		// the genuinely-clean case in test (a) above. The only difference is
		// the server is wedged: it never answers ANY request, including the
		// #1277 liveness ping added by this gate. Pre-#1277 there was nothing
		// checking this and the touch would confirm clean anyway.
		client.pingLiveness = vi.fn().mockResolvedValue(false);
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const result = await service.touchFile(filePath, "# hi\n", {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: "primary",
			source: "test",
		});

		expect((result as { inconclusive?: boolean }).inconclusive).toBe(true);
		expect(result?.confirmation).toBeUndefined();
		expect(client.pingLiveness).toHaveBeenCalled();
	});

	it("a non-primary/multi-server touch does NOT take the SINGLE-SERVER silent-clean shortcut (stays inconclusive, matching pre-#799 behavior)", async () => {
		const filePath = path.join(tmp, "a.md");
		fs.writeFileSync(filePath, "# hi\n");
		const marksman = makeServer("marksman", ".md", tmp);
		const typos = makeServer("typos", ".md", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [marksman, typos] : [],
		);
		createLSPClient.mockImplementation(async (opts: { serverId: string }) => {
			return makeSilentPushOnlyClient(opts.serverId, tmp).client;
		});

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const result = await service.touchFile(filePath, "# hi\n", {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: "all",
			source: "test",
		});

		// This #799 gate is scoped to `spawned.length === 1` and never fires
		// here. #814's generalized `clientScope: "all"` gate (see the describe
		// block below) DOES now consider multi-server "all" touches — but it
		// only resolves early when EVERY still-outstanding server is tier3-
		// silent, and `typos` is an ordinary push-only server (not marked
		// `silentOnClean`), so this touch still correctly stays inconclusive
		// rather than wrongly treating typos' silence as confirmed-clean.
		expect((result as { inconclusive?: boolean }).inconclusive).toBe(true);
	});
});

describe("touchFile capability-aware AGGREGATE wait (#814)", () => {
	let tmp: string;
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-silent-clean-agg-"));
		// Flat, tiny diagnostics-wait budget so the mocked servers' real
		// waitForDiagnostics sleep resolves in ~50ms instead of paying their real
		// (1000-1500ms) strategy budgets — keeps these tests fast without
		// changing the gate under test (readEnvDiagnosticsWaitMs, index.ts).
		process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS = "50";
	});
	afterEach(() => {
		delete process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS;
		removeTempDirSync(tmp);
	});

	it("(a) scope-all: one server publishes, the silent one doesn't — resolves as CONFIRMED clean (not inconclusive), publisher's diagnostics kept", async () => {
		const filePath = path.join(tmp, "a.md");
		fs.writeFileSync(filePath, "# hi\n");
		const marksman = makeServer("marksman", ".md", tmp);
		const typos = makeServer("typos", ".md", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [marksman, typos] : [],
		);
		const finding = {
			severity: 2 as const,
			message: "possible typo",
			range: {
				start: { line: 0, character: 2 },
				end: { line: 0, character: 4 },
			},
			source: "typos",
		};
		const attributedFinding = { ...finding, serverId: "typos" };
		createLSPClient.mockImplementation(async (opts: { serverId: string }) => {
			if (opts.serverId === "typos") {
				return makePublishingClient("typos", tmp, filePath, [finding]);
			}
			return makeSilentPushOnlyClient(opts.serverId, tmp).client;
		});

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const result = await service.touchFile(filePath, "# hi\n", {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: "all",
			source: "lens_diagnostics_full",
		});

		expect((result as { inconclusive?: boolean }).inconclusive).toBeUndefined();
		expect(result?.confirmation).toBe("confirmed");
		expect(result?.diags).toEqual([attributedFinding]);
	});

	it("#1277: scope-all — the still-outstanding silent server is WEDGED (fails the liveness ping), so the touch stays INCONCLUSIVE even though the publishing sibling answered", async () => {
		const filePath = path.join(tmp, "a.md");
		fs.writeFileSync(filePath, "# hi\n");
		const marksman = makeServer("marksman", ".md", tmp);
		const typos = makeServer("typos", ".md", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [marksman, typos] : [],
		);
		const finding = {
			severity: 2 as const,
			message: "possible typo",
			range: {
				start: { line: 0, character: 2 },
				end: { line: 0, character: 4 },
			},
			source: "typos",
		};
		createLSPClient.mockImplementation(async (opts: { serverId: string }) => {
			if (opts.serverId === "typos") {
				return makePublishingClient("typos", tmp, filePath, [finding]);
			}
			// marksman: notify write accepted, wait times out with nothing
			// published (identical to the genuinely-clean case in test (a)
			// above) — but it is wedged, so the #1277 liveness ping never
			// answers either.
			const { client } = makeSilentPushOnlyClient("marksman", tmp);
			client.pingLiveness = vi.fn().mockResolvedValue(false);
			return client;
		});

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const result = await service.touchFile(filePath, "# hi\n", {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: "all",
			source: "lens_diagnostics_full",
		});

		expect((result as { inconclusive?: boolean }).inconclusive).toBe(true);
		expect(result?.confirmation).toBeUndefined();
	});

	it("(b) scope-all: the silent server's notify write TIMED OUT — falls back to today's timeout/inconclusive behavior", async () => {
		const prev = process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
		process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = "50";
		try {
			const filePath = path.join(tmp, "a.md");
			fs.writeFileSync(filePath, "# hi\n");
			const marksman = makeServer("marksman", ".md", tmp);
			const typos = makeServer("typos", ".md", tmp);
			getServersForFileWithConfig.mockImplementation((fp: string) =>
				fp.endsWith(".md") ? [marksman, typos] : [],
			);
			const finding = {
				severity: 2 as const,
				message: "possible typo",
				range: {
					start: { line: 0, character: 2 },
					end: { line: 0, character: 4 },
				},
				source: "typos",
			};
			createLSPClient.mockImplementation(async (opts: { serverId: string }) => {
				if (opts.serverId === "typos") {
					return makePublishingClient("typos", tmp, filePath, [finding]);
				}
				// marksman's notify.open never resolves — the write itself
				// never lands, so its silence has no basis to be read as
				// "saw the file and stayed quiet because it's clean".
				const { client } = makeSilentPushOnlyClient("marksman", tmp);
				client.notify.open = vi.fn(() => new Promise(() => {}));
				return client;
			});

			const { LSPService } = await import("../../../clients/lsp/index.js");
			const service = new LSPService();

			const result = await service.touchFile(filePath, "# hi\n", {
				diagnostics: "document",
				collectDiagnostics: true,
				clientScope: "all",
				source: "lens_diagnostics_full",
			});

			expect((result as { inconclusive?: boolean }).inconclusive).toBe(true);
			expect(result?.confirmation).toBeUndefined();
		} finally {
			if (prev === undefined) delete process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
			else process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = prev;
		}
	});

	it("(c) scope-all: an ordinary push-only (non-silentOnClean) straggler still runs to cap and stays inconclusive — no behavior change", async () => {
		const filePath = path.join(tmp, "a.md");
		fs.writeFileSync(filePath, "# hi\n");
		const marksman = makeServer("marksman", ".md", tmp);
		const typos = makeServer("typos", ".md", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [marksman, typos] : [],
		);
		// Both servers are silent — marksman IS tier3-silent, but typos is an
		// ordinary push-only server (no `silentOnClean` marker in
		// wait-policy/strategies.ts), so its silence is genuinely ambiguous and must
		// not be treated as confirmed-clean.
		createLSPClient.mockImplementation(async (opts: { serverId: string }) => {
			return makeSilentPushOnlyClient(opts.serverId, tmp).client;
		});

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const result = await service.touchFile(filePath, "# hi\n", {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: "all",
			source: "lens_diagnostics_full",
		});

		expect((result as { inconclusive?: boolean }).inconclusive).toBe(true);
		const { getDegradationSummary } =
			await import("../../../clients/degradation-ledger.js");
		expect(getDegradationSummary()).toEqual([
			expect.objectContaining({
				kind: "lsp-diagnostics-timeout",
				count: 2,
				latestReasons: expect.arrayContaining([
					expect.objectContaining({ subject: "marksman" }),
					expect.objectContaining({ subject: "typos" }),
				]),
			}),
		]);
	});

	it("(d) scope-all: EVERY spawned server is silent+tier3-silent — resolves at the max of their budgets as CONFIRMED clean", async () => {
		// This test asserts the REAL per-server strategy budgets (marksman
		// 1500ms, typescript 1000ms) are what get paid — undo the describe's
		// env override so it isn't flattened to 50ms like its siblings.
		delete process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS;
		const filePath = path.join(tmp, "a.ts");
		fs.writeFileSync(filePath, "const x = 1;\n");
		const marksman = makeServer("marksman", ".ts", tmp);
		const typescript = makeServer("typescript", ".ts", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [marksman, typescript] : [],
		);
		createLSPClient.mockImplementation(async (opts: { serverId: string }) => {
			return makeSilentPushOnlyClient(opts.serverId, tmp).client;
		});

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const startedAt = Date.now();
		const result = await service.touchFile(filePath, "const x = 1;\n", {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: "all",
			source: "lens_diagnostics_full",
		});
		const elapsedMs = Date.now() - startedAt;

		expect(Array.isArray(result?.diags)).toBe(true);
		expect(result?.diags).toHaveLength(0);
		expect((result as { inconclusive?: boolean }).inconclusive).toBeUndefined();
		expect(result?.confirmation).toBe("confirmed");
		// marksman (1500ms) and typescript (1000ms) — the touch waits for the
		// SLOWER of the two (marksman), not a shortened window.
		expect(elapsedMs).toBeGreaterThanOrEqual(1490);
	});

	it("(e) scope-all: classification throws — fails safe to today's timeout/inconclusive behavior", async () => {
		const filePath = path.join(tmp, "a.md");
		fs.writeFileSync(filePath, "# hi\n");
		const marksman = makeServer("marksman", ".md", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [marksman] : [],
		);
		createLSPClient.mockImplementation(async () => {
			const { client } = makeSilentPushOnlyClient("marksman", tmp);
			// Force the capability-snapshot probe (`getCapabilitySnapshots`,
			// which reads `getAdvertisedCommands()` per live client) to throw —
			// the gate's try/catch must fail safe to today's inconclusive
			// behavior rather than propagating the error.
			client.getAdvertisedCommands = () => {
				throw new Error("boom");
			};
			return client;
		});

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const result = await service.touchFile(filePath, "# hi\n", {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: "all",
			source: "lens_diagnostics_full",
		});

		expect((result as { inconclusive?: boolean }).inconclusive).toBe(true);
	});
});

/**
 * #1253: the touch debounce must not launder a FAILED notify write into a
 * later touch that looks fully delivered.
 *
 * `markTouched` records "these servers already have this content", and
 * `shouldSkipNotify` reads that record to skip the next touch's notify
 * entirely — which also leaves that next touch's `notifyWriteTimedOut` false.
 * Both silent-clean gates (#799 single-server, #814 aggregate) treat
 * `!notifyWriteTimedOut` as proof the server SAW the content, so recording a
 * write that never landed turned a silent server's ignorance into a confirmed
 * clean one debounce window later. Since #1253 that confirmation is carried
 * all the way out to `lsp_diagnostics` (`TouchFileResult.confirmation`), so
 * the laundering surfaces as a false "clean" file rather than being absorbed
 * by the tool's own unconfirmed fallback.
 */
describe("touch debounce after a failed notify write (#1253)", () => {
	let tmp: string;
	let prevNotifyBudget: string | undefined;
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-silent-clean-debounce-"));
		process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS = "50";
		prevNotifyBudget = process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
		process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = "50";
	});
	afterEach(() => {
		delete process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS;
		if (prevNotifyBudget === undefined) {
			delete process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
		} else {
			process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = prevNotifyBudget;
		}
		removeTempDirSync(tmp);
	});

	it("re-pushes (and stays inconclusive) instead of debouncing into a silent-clean confirm", async () => {
		const filePath = path.join(tmp, "a.md");
		fs.writeFileSync(filePath, "# hi\n");
		const marksman = makeServer("marksman", ".md", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [marksman] : [],
		);
		const { client } = makeSilentPushOnlyClient("marksman", tmp);
		// Every write stalls past the notify budget — the server never receives
		// the file, so its silence is never evidence of "clean".
		const open = vi.fn(() => new Promise(() => {}));
		client.notify.open = open as never;
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const options = {
			diagnostics: "document" as const,
			collectDiagnostics: true as const,
			clientScope: "primary" as const,
			source: "test",
		};
		const first = await service.touchFile(filePath, "# hi\n", options);
		// Same content, well inside the 1500ms debounce window.
		const second = await service.touchFile(filePath, "# hi\n", options);

		expect((first as { inconclusive?: boolean }).inconclusive).toBe(true);
		expect(first?.confirmation).toBeUndefined();
		// The second touch must attempt the write again rather than assume the
		// first one landed.
		expect(open).toHaveBeenCalledTimes(2);
		expect((second as { inconclusive?: boolean }).inconclusive).toBe(true);
		expect(second?.confirmation).toBeUndefined();
	});

	it("still debounces the notify after a write that DID land", async () => {
		const filePath = path.join(tmp, "a.md");
		fs.writeFileSync(filePath, "# hi\n");
		const marksman = makeServer("marksman", ".md", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [marksman] : [],
		);
		const { client } = makeSilentPushOnlyClient("marksman", tmp);
		const open = vi.fn(async () => {});
		client.notify.open = open as never;
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const options = {
			diagnostics: "document" as const,
			collectDiagnostics: true as const,
			clientScope: "primary" as const,
			source: "test",
		};
		const first = await service.touchFile(filePath, "# hi\n", options);
		const second = await service.touchFile(filePath, "# hi\n", options);

		// One delivered push is enough for the debounce window — unchanged.
		expect(open).toHaveBeenCalledTimes(1);
		expect(first?.confirmation).toBe("confirmed");
		expect(second?.confirmation).toBe("confirmed");
	});
});
