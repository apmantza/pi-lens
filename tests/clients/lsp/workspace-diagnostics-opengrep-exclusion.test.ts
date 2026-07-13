/**
 * #584: `runWorkspaceDiagnostics`'s per-file "all"-scope sweep must NOT touch
 * the opengrep server — its findings for a full workspace scan now come from
 * the `opengrep-client.ts` CLI extractor (one project-wide scan, cached, read
 * via `project-diagnostics/extractors.ts`) instead of one LSP touch per file.
 * On a real 50-file sweep the old per-file path produced 49/50 files reporting
 * "unconfirmed (timed out)" because opengrep's own wait-tier budget dominated
 * every touch in its server group.
 *
 * This does NOT change the per-edit real-time LSP path — only the bulk sweep.
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

function makeServer(id: string, ext: string) {
	return {
		id,
		name: id,
		role: id === "opengrep" ? ("auxiliary" as const) : undefined,
		extensions: [ext],
		root: async () => "C:/repo",
		spawn: vi.fn(async () => ({ process: {}, source: "test" })),
	};
}

function mkClient(serverId: string) {
	return {
		isAlive: () => true,
		shutdown: async () => {},
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none",
		}),
		getOperationSupport: () => ({}),
		serverId,
		notify: { open: vi.fn(async () => {}) },
		waitForDiagnostics: vi.fn().mockResolvedValue(undefined),
		getDiagnostics: vi.fn(() => []),
		diagnosticsVersion: 0,
	};
}

describe("runWorkspaceDiagnostics — opengrep excluded from the bulk sweep (#584)", () => {
	let tmp: string;
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wsd-opengrep-exclude-"));
	});
	afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

	it("touches the primary server but never spawns/opens opengrep for a file it also covers", async () => {
		fs.writeFileSync(path.join(tmp, "a.py"), "x\n");

		const pyServer = makeServer("python", ".py");
		const opengrepServer = makeServer("opengrep", ".py");
		// Both servers match .py — mirrors real config, where opengrep is a
		// cross-cutting auxiliary attached alongside every primary language.
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".py") ? [pyServer, opengrepServer] : [],
		);

		const clients = new Map<string, ReturnType<typeof mkClient>>();
		const spawnedServerIds: string[] = [];
		createLSPClient.mockImplementation(async ({ serverId }: { serverId: string }) => {
			spawnedServerIds.push(serverId);
			if (!clients.has(serverId)) clients.set(serverId, mkClient(serverId));
			return clients.get(serverId);
		});

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const results = await new LSPService().runWorkspaceDiagnostics(tmp);

		expect(results.length).toBe(1);
		// The primary (python) server was spawned/touched...
		expect(spawnedServerIds).toContain("python");
		// ...but opengrep never was, even though it matches the same extension —
		// no client was even constructed for it.
		expect(spawnedServerIds).not.toContain("opengrep");
		expect(clients.has("opengrep")).toBe(false);
	});
});
