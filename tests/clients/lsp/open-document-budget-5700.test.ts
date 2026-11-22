// flake-shape: ungoverned-wait-for — the second pull must be on the server before the cap closes the document, and only the server's own trace shows that; each poll is bounded by its own timeout.
// flake-shape: real-process-spawn — the open-document cap is a wire claim (which didOpen/didClose a real server receives, in which order); a stubbed transport cannot show what the server holds
/**
 * #5700 (B1) over the real wire: each client caps its open documents.
 *
 * Recurrence this file prevents: `closeDocument` had one production caller,
 * the rename path, so a server held every document a session ever touched for
 * the client's life. Probed through the real MCP host on 2026-11-19: 100
 * files touched once each, `didOpen=100 didClose=0`.
 *
 * Nothing is doubled below the server registry: the real `LSPService`, the
 * real `createLSPClient`, and `tests/fixtures/fake-lsp-server.mjs` as a
 * push-only server that publishes one error for every document it opens
 * (`FAKE_LSP_PUSH_DIAGNOSTIC`). The cap is lowered to 3 through
 * `PI_LENS_LSP_OPEN_DOCUMENT_CAP`, the registry's one knob. The trace is read
 * only after a request round trip (`pingLiveness`), which the server answers
 * after reading every earlier message.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LSPService } from "../../../clients/lsp/index.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";
import { removeTempDirSync } from "../test-utils.js";
import { _setServersForFileForTests } from "../../../clients/lsp/config.js";

const { getServersForFileWithConfig } = vi.hoisted(() => ({
	getServersForFileWithConfig: vi.fn(),
}));

type LiveClient = {
	pingLiveness(): Promise<boolean>;
	getAllDiagnostics(): Map<
		string,
		{ diags: Array<{ code?: unknown }>; closed?: boolean }
	>;
	isDocumentOpen(filePath: string): boolean;
};

describe("#5700 open-document cap through the real client", () => {
	let tmp: string;
	beforeEach(() => {
		_setServersForFileForTests(getServersForFileWithConfig);
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-open-doc-cap-"));
		process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS = "5000";
		process.env.PI_LENS_LSP_OPEN_DOCUMENT_CAP = "3";
		resetDegradationLedger();
	});
	afterEach(() => {
		delete process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS;
		delete process.env.PI_LENS_LSP_OPEN_DOCUMENT_CAP;
		resetDegradationLedger();
		removeTempDirSync(tmp);
	});

	it("closes the least recent documents past the cap and keeps their findings, marked closed", async () => {
		const trace = path.join(tmp, "trace.log");
		fs.writeFileSync(trace, "");
		const server = {
			id: "marksman",
			name: "marksman",
			extensions: [".md"],
			idleEviction: "resident",
			root: async () => tmp,
			spawn: async () => ({
				process: await spawnFakeLspServer({
					cwd: tmp,
					env: {
						...process.env,
						FAKE_LSP_TRACE_FILE: trace,
						FAKE_LSP_NO_DIAGNOSTIC_PROVIDER: "1",
						FAKE_LSP_PUSH_DIAGNOSTIC: "1",
					},
				}),
				source: "test",
			}),
		};
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [server] : [],
		);
		const files = Array.from({ length: 6 }, (_, i) =>
			path.join(tmp, `doc-${i}.md`),
		);
		for (const file of files) fs.writeFileSync(file, `# ${file}\n`);
		const service = new LSPService();
		try {
			for (const file of files) {
				await service.touchFile(file, fs.readFileSync(file, "utf8"), {
					diagnostics: "document",
					collectDiagnostics: true,
					clientScope: "primary",
					source: "dispatch",
				});
			}
			const client = [
				...(
					service as unknown as { state: { clients: Map<string, LiveClient> } }
				).state.clients.values(),
			][0];
			const wire = async () => {
				// Barrier: the server answers after reading every earlier message.
				expect(await client.pingLiveness()).toBe(true);
				return fs
					.readFileSync(trace, "utf8")
					.split("\n")
					.flatMap(
						(line) =>
							/^recv textDocument\/(didOpen|didClose) (\S+)/
								.exec(line)
								?.slice(1, 3)
								.join(" ") ?? [],
					);
			};
			const uri = (file: string) => pathToFileURL(file).href;
			const lines = await wire();
			// Pre-#5700: six didOpens and no didClose.
			expect(lines.filter((l) => l.startsWith("didClose"))).toEqual(
				files.slice(0, 3).map((file) => `didClose ${uri(file)}`),
			);
			expect(lines.filter((l) => l.startsWith("didOpen"))).toHaveLength(6);
			expect(files.map((file) => client.isDocumentOpen(file))).toEqual([
				false,
				false,
				false,
				true,
				true,
				true,
			]);

			// The closed file's last findings stay readable, marked closed.
			const closedEntry = client
				.getAllDiagnostics()
				.get(files[0].replace(/\\/g, "/"));
			expect(closedEntry?.closed).toBe(true);
			expect(closedEntry?.diags.map((d) => d.code)).toEqual(["P2780"]);
			const serviceEntry = (await service.getAllDiagnostics()).get(
				files[0].replace(/\\/g, "/"),
			);
			expect(serviceEntry?.closed).toBe(true);
			// An open one is not.
			expect(
				client.getAllDiagnostics().get(files[5].replace(/\\/g, "/"))?.closed,
			).toBeUndefined();

			// One bounded record per server per session, not one per close.
			const capRows = getDegradationSummary().filter(
				(group) => group.kind === "lsp-open-document-cap",
			);
			expect(capRows.map((group) => group.count)).toEqual([1]);
			expect(capRows[0]?.latestReasons[0]?.subject).toBe("marksman");

			// An edit of the oldest open file makes it the most recent, so the next
			// close takes doc-4, not doc-3.
			fs.writeFileSync(files[3], "# edited\n");
			await service.touchFile(files[3], "# edited\n", {
				diagnostics: "document",
				collectDiagnostics: true,
				clientScope: "primary",
				source: "dispatch",
			});
			// A later touch of a closed file opens it again and answers fresh.
			const result = await service.touchFile(
				files[0],
				fs.readFileSync(files[0], "utf8"),
				{
					diagnostics: "document",
					collectDiagnostics: true,
					clientScope: "primary",
					source: "dispatch",
				},
			);
			expect(result?.confirmation).toBe("confirmed");
			const after = await wire();
			expect(after.at(-2)).toBe(`didOpen ${uri(files[0])}`);
			expect(after.at(-1)).toBe(`didClose ${uri(files[4])}`);
			expect(files.map((file) => client.isDocumentOpen(file))).toEqual([
				true,
				false,
				false,
				true,
				false,
				true,
			]);
			expect(
				client.getAllDiagnostics().get(files[0].replace(/\\/g, "/"))?.closed,
			).toBeUndefined();
		} finally {
			await service.shutdown();
		}
	}, 30_000);

	function markdownServer(id: string) {
		return {
			id,
			name: id,
			extensions: [".md"],
			idleEviction: "resident",
			root: async () => tmp,
			spawn: async () => ({
				process: await spawnFakeLspServer({
					cwd: tmp,
					env: {
						...process.env,
						FAKE_LSP_NO_DIAGNOSTIC_PROVIDER: "1",
						FAKE_LSP_PUSH_DIAGNOSTIC: "1",
					},
				}),
				source: "test",
			}),
		};
	}

	/**
	 * #5700 F1 (PR #5737 review): `LSPService.getAllDiagnostics` merges one
	 * file's rows across contributing clients. The aggregate is closed only when
	 * EVERY contributing row is closed. Recurrence: the merge set `closed` when
	 * any one contributor was closed, so a fresh row from a second, open server
	 * reached lsp_navigation labelled as a cap-closed last finding. Both creation
	 * orders are driven, because the merge and the first-row creation each read
	 * `closed` on their own path.
	 */
	it.each([
		["closed contributor first", ["marksman-a", "marksman-b"]],
		["open contributor first", ["marksman-b", "marksman-a"]],
	] as const)(
		"aggregate is closed only when every contributor is closed (%s)",
		async (_order, order) => {
			const servers = {
				"marksman-a": markdownServer("marksman-a"),
				"marksman-b": markdownServer("marksman-b"),
			};
			// The shared file's server order. A `didChange` clears a row the fake
			// server does not republish, so the second server opens the file alone
			// (primary scope, rotated order) and the first keeps its findings.
			let sharedOrder: ReadonlyArray<keyof typeof servers> = order;
			getServersForFileWithConfig.mockImplementation((fp: string) => {
				const name = path.basename(fp);
				if (name.startsWith("x-")) return sharedOrder.map((id) => servers[id]);
				if (name.startsWith("a-")) return [servers["marksman-a"]];
				if (name.startsWith("b-")) return [servers["marksman-b"]];
				return [];
			});
			const shared = path.join(tmp, "x-shared.md");
			const aDocs = [1, 2, 3].map((i) => path.join(tmp, `a-${i}.md`));
			const bDocs = [1, 2, 3].map((i) => path.join(tmp, `b-${i}.md`));
			for (const file of [shared, ...aDocs, ...bDocs]) {
				fs.writeFileSync(file, `# ${file}\n`);
			}
			const service = new LSPService();
			const touch = (file: string, clientScope: "primary" | "all") =>
				service.touchFile(file, fs.readFileSync(file, "utf8"), {
					diagnostics: "document",
					collectDiagnostics: true,
					clientScope,
					source: "dispatch",
				});
			const key = shared.replace(/\\/g, "/");
			const liveClients = () =>
				[
					...(
						service as unknown as {
							state: { clients: Map<string, LiveClient> };
						}
					).state.clients.entries(),
				].map(([clientKey, client]) => ({
					serverId: clientKey.split(":")[0],
					client,
				}));
			const settle = async () => {
				// Barrier: each server answers after reading every earlier message.
				for (const { client } of liveClients()) {
					expect(await client.pingLiveness()).toBe(true);
				}
			};
			const rowsById = () =>
				new Map(
					liveClients().map(({ serverId, client }) => [
						serverId,
						client.getAllDiagnostics().get(key),
					]),
				);
			try {
				await touch(shared, "primary");
				expect(liveClients().map((c) => c.serverId)).toEqual([order[0]]);
				sharedOrder = [order[1], order[0]];
				await touch(shared, "primary");
				expect(liveClients().map((c) => c.serverId)).toEqual([...order]);

				// Three more documents put marksman-a past the cap of 3. The shared
				// file is its least recently sent document, so it closes there.
				for (const file of aDocs) await touch(file, "primary");
				await settle();
				const first = rowsById();
				expect(first.get("marksman-a")?.closed).toBe(true);
				expect(first.get("marksman-b")?.closed).toBeUndefined();
				expect(first.get("marksman-b")?.diags.length).toBeGreaterThan(0);
				// marksman-b still holds the file open, so the aggregate is not closed.
				expect((await service.getAllDiagnostics()).get(key)?.closed).toBe(
					undefined,
				);

				// Now marksman-b closes it too: every contributor is closed.
				for (const file of bDocs) await touch(file, "primary");
				await settle();
				expect(rowsById().get("marksman-b")?.closed).toBe(true);
				expect((await service.getAllDiagnostics()).get(key)?.closed).toBe(true);
			} finally {
				await service.shutdown();
			}
		},
		30_000,
	);

	/**
	 * #5737 round 2 (PRRT_kwDORt8rec66iybI): a retained cap close advances the
	 * pull generation, so a pull still in flight for the closed document fails
	 * its write-time generation check and cannot replace the findings the close
	 * kept. Recurrence: the close skipped the clear that bumps the generation, so
	 * a late answer passed the check and stored over the kept rows. The second
	 * pull is held 4 s and the cap closes the document before it lands.
	 */
	it("a pull answered after a retained cap close keeps the kept findings", async () => {
		const trace = path.join(tmp, "pull-trace.log");
		fs.writeFileSync(trace, "");
		const pulled = {
			id: "pullsrv",
			name: "pullsrv",
			extensions: [".md"],
			idleEviction: "resident",
			root: async () => tmp,
			spawn: async () => ({
				process: await spawnFakeLspServer({
					cwd: tmp,
					env: {
						...process.env,
						FAKE_LSP_TRACE_FILE: trace,
						// The first pull answers at once; each later pull waits this long.
						FAKE_LSP_DELAY_AFTER_FIRST_PULL_MS: "4000",
					},
				}),
				source: "test",
			}),
		};
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [pulled] : [],
		);
		const shared = path.join(tmp, "x-pull.md");
		const aDocs = [1, 2, 3].map((i) => path.join(tmp, `a-pull-${i}.md`));
		for (const file of [shared, ...aDocs]) {
			fs.writeFileSync(file, `# ${file}\n`);
		}
		const service = new LSPService();
		const touch = (file: string) =>
			service.touchFile(file, fs.readFileSync(file, "utf8"), {
				diagnostics: "document",
				collectDiagnostics: true,
				clientScope: "primary",
				source: "dispatch",
			});
		const key = shared.replace(/\\/g, "/");
		const sharedUri = pathToFileURL(shared).href;
		const traceLines = () => fs.readFileSync(trace, "utf8").split("\n");
		const pullsOfShared = () =>
			traceLines().filter(
				(line) => line === `recv textDocument/diagnostic ${sharedUri}`,
			).length;
		try {
			await touch(shared);
			const kept = (await service.getAllDiagnostics()).get(key);
			expect(kept?.diags.length).toBeGreaterThan(0);
			expect(kept?.closed).toBeUndefined();

			// The second pull is on the server before the cap closes the shared file.
			const late = touch(shared);
			await vi.waitFor(
				() => expect(pullsOfShared()).toBeGreaterThanOrEqual(2),
				{ timeout: 10_000, interval: 20 },
			);
			const others = aDocs.map((file) => touch(file));
			await vi.waitFor(
				() =>
					expect(traceLines()).toContain(
						`recv textDocument/didClose ${sharedUri}`,
					),
				{ timeout: 10_000, interval: 20 },
			);
			await late;
			await Promise.all(others);

			const after = (await service.getAllDiagnostics()).get(key);
			expect(after?.closed).toBe(true);
			// The late answer was refused: the kept row still has the first pull's stamp.
			expect(after?.ts).toBe(kept?.ts);
		} finally {
			await service.shutdown();
		}
	}, 30_000);
});
