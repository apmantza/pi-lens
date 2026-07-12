/**
 * #586: `runWorkspaceDiagnostics` (the sweep behind `lens_diagnostics
 * mode=full`) previously read raw LSP diagnostics with no auxiliary-profile
 * suppression filtering, so a `// nosemgrep` comment that correctly
 * suppressed a finding during per-edit dispatch still showed up here for the
 * exact same file. This guards the fix: the sweep must apply
 * `applyAuxiliarySuppressions` the same way the per-edit dispatch runner and
 * `tools/lsp-diagnostics.ts` do.
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
		extensions: [ext],
		root: async () => "C:/repo",
		spawn: vi.fn(async () => ({ process: {}, source: "test" })),
	};
}

const RULE = "generic.secrets.security.detected-github-token";
function semgrepDiag(line0Based: number) {
	return {
		severity: 1,
		message: "GitHub token detected",
		range: {
			start: { line: line0Based, character: 0 },
			end: { line: line0Based, character: 10 },
		},
		source: "Semgrep",
		code: RULE,
	};
}

describe("runWorkspaceDiagnostics — auxiliary inline-suppression (#586)", () => {
	let tmp: string;
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		delete process.env.PI_LENS_LSP_WORKSPACE_PULL;
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wsd-nosemgrep-"));
	});
	afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

	it("drops a `// nosemgrep`-suppressed opengrep finding from the sweep", async () => {
		const suppressed = path.join(tmp, "suppressed.py");
		fs.writeFileSync(suppressed, "token = 'x'  // nosemgrep\n");

		const server = makeServer("opengrep", ".py");
		getServersForFileWithConfig.mockReturnValue([server]);
		createLSPClient.mockResolvedValue({
			isAlive: () => true,
			shutdown: async () => {},
			serverId: "opengrep",
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			notify: { open: vi.fn(async () => {}) },
			waitForDiagnostics: vi.fn().mockResolvedValue(undefined),
			getDiagnostics: vi.fn(() => [semgrepDiag(0)]),
		});

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const results = await new LSPService().runWorkspaceDiagnostics(tmp);

		expect(results.length).toBe(1);
		expect(results[0]?.diagnostics).toEqual([]);
		expect(results[0]?.count).toBe(0);
	});

	it("keeps the same finding when the file has no nosemgrep comment", async () => {
		const unsuppressed = path.join(tmp, "unsuppressed.py");
		fs.writeFileSync(unsuppressed, "token = 'x'\n");

		const server = makeServer("opengrep", ".py");
		getServersForFileWithConfig.mockReturnValue([server]);
		createLSPClient.mockResolvedValue({
			isAlive: () => true,
			shutdown: async () => {},
			serverId: "opengrep",
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			notify: { open: vi.fn(async () => {}) },
			waitForDiagnostics: vi.fn().mockResolvedValue(undefined),
			getDiagnostics: vi.fn(() => [semgrepDiag(0)]),
		});

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const results = await new LSPService().runWorkspaceDiagnostics(tmp);

		expect(results.length).toBe(1);
		expect(results[0]?.count).toBe(1);
	});
});
