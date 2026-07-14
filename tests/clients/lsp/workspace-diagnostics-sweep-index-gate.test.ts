/**
 * #645: a full-tree `lens_diagnostics mode=full` sweep fires a `didOpen` for
 * every file matching a `workspaceIndexing`-strategy server (marksman today —
 * see server-strategies.ts) in close succession. Before this fix, every one
 * of those touches independently paid that server's full `aggregateWaitMs`
 * (1500ms for marksman) racing the SAME one-time workspace-index build, so a
 * real project with 34 markdown files burned ~34 * 1500ms of structurally-
 * doomed wait in one sweep — not because marksman is slow per file, but
 * because the one-time index cost was charged once per file.
 *
 * `runWorkspaceDiagnostics` now creates one `SweepIndexGate` per sweep
 * (clients/lsp/index.ts) and threads it into every `touchFile` call via
 * `sweepIndexGate`. `touchFile`'s `perServerTimeout` consults the gate only
 * for a server whose strategy is marked `workspaceIndexing: true`: the FIRST
 * file touching that server in the sweep gets the full `aggregateWaitMs`
 * budget; every subsequent file in the SAME sweep gets the much shorter
 * `workspaceIndexingWarmWaitMs` instead. This test asserts that timing
 * behavior directly (the `ms` argument passed to `waitForDiagnostics`) and
 * separately confirms a genuine timeout on a warm-wait touch still reports
 * `timedOut: true` — the #634 unconfirmed/inconclusive contract must not
 * regress into a false-clean read just because the wait got shorter.
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

function makeMarksmanServer() {
	return {
		id: "marksman",
		name: "marksman",
		extensions: [".md"],
		root: async () => "C:/repo",
		spawn: vi.fn(async () => ({ process: {}, source: "test" })),
	};
}

describe("runWorkspaceDiagnostics — sweep-scoped index gate for workspaceIndexing servers (#645)", () => {
	let tmp: string;
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wsd-indexgate-"));
	});
	afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

	it("gives the first same-sweep markdown file the full budget and later ones the short warm wait, while a genuine later timeout still reports timedOut", async () => {
		const names = ["a.md", "b.md", "c.md"];
		for (const n of names) fs.writeFileSync(path.join(tmp, n), "# x\n");

		const markServer = makeMarksmanServer();
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [markServer] : [],
		);

		const waitCalls: Array<{ filePath: string; ms: number }> = [];
		let fileIndex = 0;

		const client = {
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			serverId: "marksman",
			notify: { open: vi.fn(async () => {}) },
			waitForDiagnostics: vi.fn(async (filePath: string, ms: number) => {
				waitCalls.push({ filePath, ms });
				fileIndex += 1;
				// The 3rd file (2nd warm-wait touch) genuinely never gets a
				// publish within its (short) budget — real-clock wait so the
				// touch's own waitedMs >= timeoutMs check fires honestly,
				// exactly like an actual server that hasn't warmed up yet.
				if (fileIndex === 3) {
					await new Promise((resolve) => setTimeout(resolve, ms));
					return undefined;
				}
				return undefined;
			}),
			getDiagnostics: vi.fn(() => []),
		};
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		// #667: prime the server as already-demonstrated-ready via an ordinary
		// touch BEFORE the sweep, so the sweep's own pre-loop `ensureWarmForSweep`
		// warm-check is a no-op here — this test is exercising the #645
		// sweep-scoped index-gate mechanism, not the #667 warm-up round trip
		// (that has its own dedicated coverage in sweep-warmup.test.ts). Reset
		// the shared counters afterward so the assertions below still describe
		// exactly the real sweep's own touches, unaffected by the priming call.
		await service.touchFile(path.join(tmp, "a.md"), "# x\n", {
			diagnostics: "document",
			collectDiagnostics: false,
			clientScope: "primary",
			source: "test_prewarm",
		});
		waitCalls.length = 0;
		fileIndex = 0;

		const results = await service.runWorkspaceDiagnostics(tmp);

		expect(results.length).toBe(3);
		expect(waitCalls.length).toBe(3);

		// First same-sweep touch to "marksman" pays the full strategy budget
		// (1500ms per server-strategies.ts); the next two touches in the SAME
		// sweep use the much shorter warm-wait budget (250ms) instead of
		// independently re-paying the full 1500ms each.
		expect(waitCalls[0]?.ms).toBe(1500);
		expect(waitCalls[1]?.ms).toBe(250);
		expect(waitCalls[2]?.ms).toBe(250);

		// The fast (mocked-instant) first two touches were NOT flagged as
		// timed out — a short warm wait is not automatically a timeout.
		const byName = (name: string) =>
			results.find((r) => r.filePath.endsWith(name));
		expect(byName("a.md")?.timedOut).toBeFalsy();
		expect(byName("b.md")?.timedOut).toBeFalsy();
		// The 3rd file's warm-wait touch genuinely never got a publish within
		// its (shorter) budget — the #634 unconfirmed/inconclusive contract
		// must still catch this as a real timeout, not a false-clean result.
		expect(byName("c.md")?.timedOut).toBe(true);
	});

	it("does not shorten a non-workspaceIndexing server's per-sweep wait (fail-safe default)", async () => {
		const names = ["a.py", "b.py"];
		for (const n of names) fs.writeFileSync(path.join(tmp, n), "x\n");

		const pyServer = {
			id: "python",
			name: "python",
			extensions: [".py"],
			root: async () => "C:/repo",
			spawn: vi.fn(async () => ({ process: {}, source: "test" })),
		};
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".py") ? [pyServer] : [],
		);

		const waitCalls: number[] = [];
		const client = {
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			serverId: "python",
			notify: { open: vi.fn(async () => {}) },
			waitForDiagnostics: vi.fn(async (_filePath: string, ms: number) => {
				waitCalls.push(ms);
				return undefined;
			}),
			getDiagnostics: vi.fn(() => []),
		};
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		// #667: prime the server as already-warm before the sweep (see the
		// comment on the test above) so the pre-loop warm-check is a no-op and
		// doesn't add its own extra `waitForDiagnostics` call to this array.
		await service.touchFile(path.join(tmp, "a.py"), "x\n", {
			diagnostics: "document",
			collectDiagnostics: false,
			clientScope: "primary",
			source: "test_prewarm",
		});
		waitCalls.length = 0;

		await service.runWorkspaceDiagnostics(tmp);

		// python's strategy has no `workspaceIndexing` flag — every touch in
		// the sweep keeps paying its own full strategy budget (1500ms per
		// server-strategies.ts), unaffected by the #645 gate.
		expect(waitCalls).toEqual([1500, 1500]);
	});
});
