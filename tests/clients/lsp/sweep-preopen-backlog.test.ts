/**
 * #3585: the workspace sweep's pre-open pass charges the auxiliary backlog
 * ledger only for a write the client actually sent.
 *
 * Recurrence this file prevents: the pre-open pass called `noteAuxNotifyIssued`
 * after `notify.open` settled and ignored its `false` result (a write the
 * client refused — dead connection, unsupported language), so the ledger held a
 * phantom +1 per refused file and the next drain barrier was paid for a
 * document the server never received. The touch path already gates the same
 * call on `sent !== false`.
 *
 * Production chain: the REAL `LSPService.runWorkspaceDiagnostics` (pre-open
 * pass, then per-file `touchFile`) over client doubles; the ledger is read from
 * the service's own `auxNotifyInflight` at each write the auxiliary receives.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
vi.mock("../../../clients/lsp/client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/client.js")>()),
	createLSPClient,
}));

function makeServer(id: string, role?: "auxiliary") {
	return {
		id,
		name: id,
		role,
		extensions: [".ts"],
		idleEviction: "resident",
		root: async () => "/repo",
		spawn: vi.fn(async () => ({ process: {}, source: "test" })),
	};
}

function makeClient(
	serverId: string,
	open: (filePath: string) => Promise<boolean | undefined>,
) {
	return {
		isAlive: () => true,
		shutdown: async () => {},
		serverId,
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none",
		}),
		getOperationSupport: () => ({}),
		notify: { open: vi.fn(open) },
		waitForDiagnostics: vi.fn(async () => undefined),
		getDiagnostics: vi.fn(() => []),
		getDiagnosticsVersionForPath: () => 0,
		pingLiveness: vi.fn(async () => true),
		diagnosticsVersion: 0,
	};
}

type Raw = {
	auxNotifyInflight: Map<string, { unacked: number }>;
	runWorkspaceDiagnostics(root: string): Promise<unknown>;
};

describe("#3585 sweep pre-open backlog accounting", () => {
	let tmp: string;
	beforeEach(async () => {
		vi.resetModules();
		(await import("../../../clients/lsp/config.js"))._setServersForFileForTests(
			getServersForFileWithConfig,
		);
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-sweep-backlog-"));
	});
	afterEach(() => removeTempDirSync(tmp));

	async function sweep(firstOpenResult: boolean | undefined) {
		const file = path.join(tmp, "a.ts");
		fs.writeFileSync(file, "x\n");
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("ast-grep", "auxiliary"),
		]);
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const raw = new LSPService() as unknown as Raw;
		const ledgerAtWrite: Array<number | undefined> = [];
		let calls = 0;
		const aux = makeClient("ast-grep", async () => {
			ledgerAtWrite.push([...raw.auxNotifyInflight.values()][0]?.unacked);
			calls += 1;
			return calls === 1 ? firstOpenResult : undefined;
		});
		createLSPClient.mockImplementation(async (options: { serverId?: string }) =>
			options?.serverId === "ast-grep"
				? aux
				: makeClient("typescript", async () => undefined),
		);
		await raw.runWorkspaceDiagnostics(tmp);
		return { ledgerAtWrite, aux };
	}

	it("does not count a pre-open write the client refused", async () => {
		const { ledgerAtWrite } = await sweep(false);
		expect(ledgerAtWrite.length).toBeGreaterThan(1);
		// The write after the refused pre-open sees an EMPTY ledger.
		expect(ledgerAtWrite[1]).toBeUndefined();
	});

	it("counts a pre-open write the client sent", async () => {
		const { ledgerAtWrite } = await sweep(undefined);
		expect(ledgerAtWrite[1]).toBe(1);
	});
});
