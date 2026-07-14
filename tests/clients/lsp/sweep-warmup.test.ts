/**
 * #667: neither `lsp_diagnostics` nor `lens_diagnostics` had a warm-check
 * step before starting their per-file sweep loop. `serverCountReady:1` only
 * proves the server process spawned and passed the LSP `initialize`
 * handshake — a tsserver-style server can still be loading/indexing the
 * project internally for seconds after that, so whichever file(s) land
 * first in a sweep paid that cost as individual per-file timeouts (observed:
 * the first 5 files of a real 100-file sweep all hit the exact per-file
 * ceiling with `serverCountReady:1`, file 6 onward clean and fast).
 *
 * `LSPService.ensureWarmForSweep` (clients/lsp/index.ts) is the ONE shared
 * fix both tools route through: a real "has this server already answered a
 * confirmed diagnostics touch this session" check (`isDemonstratedReady`,
 * set by `touchFile` on a non-inconclusive diagnostics-mode result), not
 * just `isAlive()`. Cold → exactly one bounded warm-up round trip before the
 * real sweep. Already-warm → a no-op, no extra round trip, no added latency
 * — this file also guards the "must not become a mandatory extra round trip
 * every time" regression the issue explicitly calls out.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../../clients/lsp/client.js", () => ({ createLSPClient }));

function makeTsServer(root: string) {
	return {
		id: "typescript",
		name: "typescript",
		extensions: [".ts"],
		root: async () => root,
		spawn: vi.fn(async () => ({ process: {}, source: "test" })),
	};
}

/** Fake client: one shared instance (real servers are single per project root). */
function makeFakeClient(root: string) {
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
			serverId: "typescript",
			root,
			notify: { open: vi.fn(async () => {}) },
			waitForDiagnostics: vi.fn(async (filePath: string, ms: number) => {
				waitCalls.push({ filePath, ms });
				return undefined;
			}),
			getDiagnostics: vi.fn(() => []),
		},
		waitCalls,
	};
}

describe("LSPService.ensureWarmForSweep (#667)", () => {
	let tmp: string;
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-warmup-"));
	});
	afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

	it("performs exactly one warm-up round trip against a cold server, then treats it as warm (pure decision-logic: fake client state)", async () => {
		const filePath = path.join(tmp, "a.ts");
		fs.writeFileSync(filePath, "const x = 1;\n");
		const tsServer = makeTsServer(tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [tsServer] : [],
		);
		const { client, waitCalls } = makeFakeClient(tmp);
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Cold: server has never answered a diagnostics touch — must perform
		// the warm-up round trip.
		const first = await service.ensureWarmForSweep(filePath);
		expect(first.performedWarmup).toBe(true);
		expect(waitCalls.length).toBe(1);

		// Now warm (the warm-up touch itself confirmed diagnostics, marking the
		// client ready) — calling again must be a no-op: no extra round trip.
		const second = await service.ensureWarmForSweep(filePath);
		expect(second.performedWarmup).toBe(false);
		expect(waitCalls.length).toBe(1); // unchanged — no new round trip
	});

	it("is a no-op for a server that already answered a real touchFile diagnostics call earlier in the session", async () => {
		const filePath = path.join(tmp, "b.ts");
		fs.writeFileSync(filePath, "const y = 2;\n");
		const tsServer = makeTsServer(tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [tsServer] : [],
		);
		const { client, waitCalls } = makeFakeClient(tmp);
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Simulate an ordinary (non-sweep) per-edit touch earlier in the
		// session already confirming this server can answer diagnostics.
		await service.touchFile(filePath, "const y = 2;\n", {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: "primary",
			source: "test_prior_touch",
		});
		expect(waitCalls.length).toBe(1);

		const result = await service.ensureWarmForSweep(filePath);
		expect(result.performedWarmup).toBe(false);
		expect(waitCalls.length).toBe(1); // no extra round trip on top of the prior touch
	});
});

describe("runWorkspaceDiagnostics sweep-level warm-up behavior (#667)", () => {
	let tmp: string;
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-warmup-sweep-"));
	});
	afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

	it("a cold sweep pays exactly one extra warm-up round trip before the per-file loop, on top of the normal per-file touches", async () => {
		const names = ["a.ts", "b.ts", "c.ts"];
		for (const n of names) fs.writeFileSync(path.join(tmp, n), "const z = 1;\n");
		const tsServer = makeTsServer(tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [tsServer] : [],
		);
		const { client, waitCalls } = makeFakeClient(tmp);
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const results = await service.runWorkspaceDiagnostics(tmp);

		expect(results.length).toBe(3);
		// 3 real per-file sweep touches + exactly 1 extra warm-up round trip
		// against whichever file the sweep grouped first — NOT a blind delay
		// per file, one deliberate warm-up for the whole (single-server) group.
		expect(waitCalls.length).toBe(4);
	});

	it("a sweep against an already-warm server (demonstrated ready from a prior touch this session) skips the warm-up round trip entirely — no added latency", async () => {
		const names = ["a.ts", "b.ts", "c.ts"];
		for (const n of names) fs.writeFileSync(path.join(tmp, n), "const z = 1;\n");
		const tsServer = makeTsServer(tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [tsServer] : [],
		);
		const { client, waitCalls } = makeFakeClient(tmp);
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Warm the server up front via an ordinary confirmed touch (mirrors an
		// earlier tool call / earlier sweep in the same session).
		const primed = path.join(tmp, "a.ts");
		await service.touchFile(primed, "const z = 1;\n", {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: "primary",
			source: "test_prior_touch",
		});
		expect(waitCalls.length).toBe(1);

		const results = await service.runWorkspaceDiagnostics(tmp);
		expect(results.length).toBe(3);
		// Exactly the 3 real per-file touches — the pre-sweep warm-up check
		// found the server already demonstrated ready and skipped it (no 4th,
		// warm-up-only call).
		expect(waitCalls.length).toBe(1 + 3);
	});
});
