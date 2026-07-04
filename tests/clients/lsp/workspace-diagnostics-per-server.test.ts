/**
 * #387: the workspace-diagnostics sweep must serialize touches WITHIN a single
 * language server (tsserver et al. are single-threaded per project — concurrent
 * touches only queue, inflate the working set, and cascade budget timeouts) but
 * still parallelize ACROSS distinct servers. Guards against a regression back to
 * the old flat 8-wide pool that flooded one server.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
vi.mock("../../../clients/lsp/config.js", () => ({ getServersForFileWithConfig }));
vi.mock("../../../clients/lsp/client.js", () => ({ createLSPClient }));

function makeServer(id: string, ext: string) {
	return {
		id,
		name: id,
		extensions: [ext],
		root: async () => "C:/repo",
		spawn: vi.fn(async () => ({ process: {}, source: "test" })),
	};
}

describe("runWorkspaceDiagnostics — per-server serialization (#387)", () => {
	let tmp: string;
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wsd-perserver-"));
	});
	afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

	it("never runs two concurrent touches against one server, but overlaps distinct servers", async () => {
		for (const n of ["a.py", "b.py", "c.py"])
			fs.writeFileSync(path.join(tmp, n), "x\n");
		for (const n of ["d.ts", "e.ts", "f.ts"])
			fs.writeFileSync(path.join(tmp, n), "x\n");

		// Stable server objects (client resolution keys off server identity).
		const pyServer = makeServer("python", ".py");
		const tsServer = makeServer("typescript", ".ts");
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".py")
				? [pyServer]
				: fp.endsWith(".ts")
					? [tsServer]
					: [],
		);

		const live = new Map<string, number>();
		const maxPerServer = new Map<string, number>();
		let crossServerOverlap = false;

		const mkClient = (serverId: string) => ({
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			serverId,
			notify: {
				open: vi.fn(async () => {
					const n = (live.get(serverId) ?? 0) + 1;
					live.set(serverId, n);
					maxPerServer.set(
						serverId,
						Math.max(maxPerServer.get(serverId) ?? 0, n),
					);
					if ([...live.values()].filter((v) => v > 0).length > 1)
						crossServerOverlap = true;
					await new Promise((r) => setTimeout(r, 20));
					live.set(serverId, (live.get(serverId) ?? 1) - 1);
				}),
			},
			waitForDiagnostics: vi.fn().mockResolvedValue(undefined),
			getDiagnostics: vi.fn(() => []),
		});

		const clients = new Map<string, ReturnType<typeof mkClient>>();
		createLSPClient.mockImplementation(async ({ serverId }: { serverId: string }) => {
			if (!clients.has(serverId)) clients.set(serverId, mkClient(serverId));
			return clients.get(serverId);
		});

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const results = await new LSPService().runWorkspaceDiagnostics(tmp);

		expect(results.length).toBe(6);
		// Serial within each server: at most one in-flight touch at a time.
		expect(maxPerServer.get("python")).toBe(1);
		expect(maxPerServer.get("typescript")).toBe(1);
		// But the two distinct servers ran concurrently.
		expect(crossServerOverlap).toBe(true);
	});
});
