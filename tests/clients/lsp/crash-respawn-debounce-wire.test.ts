/**
 * #3501 over the real wire: a SIGKILLed server's touch-debounce entry does
 * not stop its respawned replacement from receiving the document.
 *
 * Recurrence this file prevents: the pipeline's `lsp_sync` touch landed on
 * server A, A died, and the dispatch runner's touch of the same content
 * respawned server B and skipped B's `didOpen` on A's debounce entry. B never
 * saw the file, and marksman's silence was then confirmed clean.
 *
 * Nothing is doubled below the server registry: the real `LSPService`, the
 * real `createLSPClient`, and `tests/fixtures/fake-lsp-server.mjs` as a
 * push-only "marksman" that publishes one error for every document it opens
 * (`FAKE_LSP_PUSH_DIAGNOSTIC`). Ordering is by barriers, never by sleeps: A's
 * own `exit` event before the second touch, and a request round trip on B
 * (answered only after B has read every earlier message) before B's trace is
 * read.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LSPService } from "../../../clients/lsp/index.js";
import type { LSPProcess } from "../../../clients/lsp/launch.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";
import { removeTempDirSync } from "../test-utils.js";

const { getServersForFileWithConfig } = vi.hoisted(() => ({
	getServersForFileWithConfig: vi.fn(),
}));
vi.mock("../../../clients/lsp/config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/config.js")>()),
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

describe("#3501 — real-wire crash between two same-content touches", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-crash-wire-"));
		// Generous: the fixed path is answered by B's publish, not by this budget.
		process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS = "5000";
		vi.useFakeTimers({ toFake: ["Date"] });
	});
	afterEach(() => {
		vi.useRealTimers();
		delete process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS;
		removeTempDirSync(tmp);
	});

	it("the respawned server receives didOpen for the file and its error is reported", async () => {
		const procs: LSPProcess[] = [];
		const traces: string[] = [];
		const filePath = path.join(tmp, "a.md");
		const content = "# broken [link](\n";
		fs.writeFileSync(filePath, content);
		const server = {
			id: "marksman",
			name: "marksman",
			extensions: [".md"],
			root: async () => tmp,
			spawn: async () => {
				const trace = path.join(tmp, `trace-${procs.length}.log`);
				fs.writeFileSync(trace, "");
				traces.push(trace);
				const proc = await spawnFakeLspServer({
					cwd: tmp,
					env: {
						...process.env,
						FAKE_LSP_TRACE_FILE: trace,
						FAKE_LSP_NO_DIAGNOSTIC_PROVIDER: "1",
						FAKE_LSP_PUSH_DIAGNOSTIC: "1",
					},
				});
				procs.push(proc);
				return { process: proc, source: "test" };
			},
		};
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [server] : [],
		);
		const service = new LSPService();
		try {
			await service.touchFile(path.join(tmp, "warm.md"), "# warm\n", {
				diagnostics: "none",
				clientScope: "primary",
				source: "warm",
			});
			// A has served past the 60 s early-exit threshold, so its death
			// respawns at once instead of entering the breaker cooldown.
			vi.setSystemTime(Date.now() + 61_000);

			await service.touchFile(filePath, content, {
				diagnostics: "none",
				clientScope: "primary",
				source: "lsp_sync",
			});
			const exited = new Promise((resolve) =>
				procs[0].process.once("exit", resolve),
			);
			procs[0].process.kill("SIGKILL");
			await exited;
			vi.useRealTimers();

			const result = await service.touchFile(filePath, content, {
				diagnostics: "document",
				collectDiagnostics: true,
				clientScope: "primary",
				source: "dispatch",
			});

			expect(procs).toHaveLength(2);
			const clients = (
				service as unknown as {
					state: {
						clients: Map<string, { pingLiveness(): Promise<boolean> }>;
					};
				}
			).state.clients;
			expect(await [...clients.values()][0].pingLiveness()).toBe(true);
			const didOpens = fs
				.readFileSync(traces[1], "utf8")
				.split("\n")
				.filter((line) => line.startsWith("recv textDocument/didOpen"));
			// Pre-#3501: no didOpen on B, and `confirmed` with no diagnostics.
			expect({
				didOpens,
				confirmation: result?.confirmation,
				diags: result?.diags,
			}).toEqual({
				didOpens: [`recv textDocument/didOpen ${pathToFileURL(filePath).href}`],
				confirmation: "confirmed",
				diags: [expect.objectContaining({ code: "P2780" })],
			});
		} finally {
			await service.shutdown();
		}
	}, 30_000);
});
