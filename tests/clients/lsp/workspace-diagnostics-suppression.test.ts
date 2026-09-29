/**
 * #586: `runWorkspaceDiagnostics` (the sweep behind `lens_diagnostics
 * mode=full`) previously read raw LSP diagnostics with no auxiliary-profile
 * suppression filtering, so a `// nosemgrep` comment that correctly
 * suppressed a finding during per-edit dispatch still showed up here for the
 * exact same file. This guards the fix: the sweep must apply
 * `applyAuxiliarySuppressions` the same way the per-edit dispatch runner and
 * `tools/lsp-diagnostics.ts` do.
 *
 * #584 update: opengrep itself no longer participates in this sweep at all
 * (`WORKSPACE_SWEEP_EXCLUDED_SERVER_IDS` in `clients/lsp/index.ts`) — its
 * findings for a full-workspace scan now come from a dedicated CLI extractor
 * (`opengrep-client.ts`), which honors `// nosemgrep` natively at the scan
 * engine level (verified in `tests/clients/opengrep-client.test.ts`), so no
 * extra filtering is needed there either. These tests below exercise the
 * GENERIC `applyAuxiliarySuppressions` wiring against a server that DOES
 * still flow through the sweep (`ast-grep`) rather than opengrep — the
 * profile lookup keys off the diagnostic's `source` field (e.g. "Semgrep"),
 * not the spawning server's id, so this still proves the sweep applies
 * suppression to whatever auxiliary diagnostics it collects, regardless of
 * which server produced them.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";

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
		idleEviction: "resident",
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
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-wsd-nosemgrep-"));
	});
	afterEach(() => removeTempDirSync(tmp));

	it("drops a `// nosemgrep`-suppressed finding from the sweep (generic wiring, non-opengrep server)", async () => {
		const suppressed = path.join(tmp, "suppressed.py");
		fs.writeFileSync(suppressed, "token = 'x'  // nosemgrep\n");

		// #584: opengrep itself is excluded from this sweep now — use a server
		// that's still touched (ast-grep) to prove `applyAuxiliarySuppressions`
		// is still wired in generically. The diagnostic's `source: "Semgrep"`
		// (from `semgrepDiag`) is what routes it through the opengrep profile's
		// `isSuppressed` regardless of which server produced it.
		const server = makeServer("ast-grep", ".py");
		getServersForFileWithConfig.mockReturnValue([server]);
		createLSPClient.mockResolvedValue({
			isAlive: () => true,
			shutdown: async () => {},
			serverId: "ast-grep",
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

	it("keeps the same finding when the file has no nosemgrep comment (generic wiring, non-opengrep server)", async () => {
		const unsuppressed = path.join(tmp, "unsuppressed.py");
		fs.writeFileSync(unsuppressed, "token = 'x'\n");

		// See the top-of-file note: opengrep is excluded from the sweep (#584),
		// so this uses ast-grep (still swept) to prove the generic
		// `applyAuxiliarySuppressions` call doesn't drop findings when there's
		// nothing to suppress.
		const server = makeServer("ast-grep", ".py");
		getServersForFileWithConfig.mockReturnValue([server]);
		createLSPClient.mockResolvedValue({
			isAlive: () => true,
			shutdown: async () => {},
			serverId: "ast-grep",
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

/**
 * #3041 recurrence: the `mode=full` sweep re-surfaced ast-grep findings on
 * paths the rule's OWN `ignores` globs carve out (#965). ast-grep applies those
 * globs during its `scan` walk but not to the per-document diagnostics its LSP
 * publishes (measured against ast-grep 0.45.3), so the sweep has to apply them —
 * the third member of the same class as #586 (nosemgrep) and #692 (skipTestFiles)
 * above.
 */
describe("runWorkspaceDiagnostics — per-rule ignores carve-out (#3041)", () => {
	let tmp: string;
	// The shipped catalog rule that carves out `scripts/**` (#965).
	const RULE = "no-console-except-error";
	const consoleDiag = () => ({
		severity: 2,
		message: "Avoid console.log/debug/warn in production code",
		range: {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 11 },
		},
		source: "ast-grep",
		code: RULE,
	});

	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		delete process.env.PI_LENS_LSP_WORKSPACE_PULL;
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-wsd-rule-ignores-"));
	});
	afterEach(() => removeTempDirSync(tmp));

	async function sweep(relative: string) {
		const file = path.join(tmp, relative);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "console.log('cli output');\n");
		const server = makeServer("ast-grep", ".ts");
		getServersForFileWithConfig.mockReturnValue([server]);
		createLSPClient.mockResolvedValue({
			isAlive: () => true,
			shutdown: async () => {},
			serverId: "ast-grep",
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			notify: { open: vi.fn(async () => {}) },
			waitForDiagnostics: vi.fn().mockResolvedValue(undefined),
			getDiagnostics: vi.fn(() => [consoleDiag()]),
		});
		const { LSPService } = await import("../../../clients/lsp/index.js");
		return await new LSPService().runWorkspaceDiagnostics(tmp);
	}

	it("drops a finding whose rule carves out the swept path", async () => {
		const results = await sweep(path.join("scripts", "cli.ts"));
		expect(results.length).toBe(1);
		expect(results[0]?.diagnostics).toEqual([]);
		expect(results[0]?.count).toBe(0);
	});

	it("keeps the same finding on a path the rule does not carve out", async () => {
		const results = await sweep(path.join("src", "app.ts"));
		expect(results.length).toBe(1);
		expect(results[0]?.diagnostics).toHaveLength(1);
		expect(results[0]?.count).toBe(1);
	});
});
