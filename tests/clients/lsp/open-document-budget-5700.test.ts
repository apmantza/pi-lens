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
			expect(after.at(-1)).toBe(`didClose ${uri(files[3])}`);
			expect(
				client.getAllDiagnostics().get(files[0].replace(/\\/g, "/"))?.closed,
			).toBeUndefined();
		} finally {
			await service.shutdown();
		}
	}, 30_000);
});
