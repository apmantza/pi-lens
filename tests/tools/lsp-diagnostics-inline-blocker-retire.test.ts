/**
 * #1561: a fresh, confirmed `lsp_diagnostics` verdict must retire the file's
 * stale INLINE BLOCKER, not only correct the widget footer.
 *
 * #571 wired this tool's confirmed result into `reconcileScanDiagnostics` and
 * stopped there. The inline-blocker map (`RuntimeCoordinator._pendingInline
 * Blockers`) is a second agent-facing store fed by the same dispatch verdict,
 * invalidated only by a later dispatch of the SAME path or that path's deletion
 * (#1245). In the live dogfood incident the blocker sat on a TEST file while its
 * cause lived in the provider the test imports, so fixing the cause
 * re-dispatched the provider and the test file's verdict was never re-taken —
 * `turn_end` re-injected "Unresolved from this turn — L320…" on six consecutive
 * turn ends, three of them AFTER this tool had answered "confirmed clean" for
 * that exact file.
 *
 * These tests drive the REAL tool with only the server registry and client
 * transport faked (the `tests/tools/lsp-diagnostics-silent-clean-flow.test.ts`
 * pattern), so the retire has to actually flow from a verdict the confirmation
 * machinery produced — not from a hand-set flag. The three cases that matter are
 * the three the callback must distinguish: confirmed clean (retire), confirmed
 * WITH a blocking finding (keep), and unconfirmed (keep).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { removeTempDirSync } from "../clients/test-utils.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../clients/lsp/config.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../clients/lsp/config.js")
	>("../../clients/lsp/config.js");
	return {
		...actual,
		getServersForFileWithConfig: (filePath: string) =>
			getServersForFileWithConfig(filePath),
		getServerInitOverride: () => undefined,
		primaryServerId: (filePath: string) =>
			(
				getServersForFileWithConfig(filePath) as
					| Array<{ id: string; role?: string }>
					| undefined
			)?.find((server) => server.role !== "auxiliary")?.id,
	};
});

vi.mock("../../clients/lsp/client.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../clients/lsp/client.js")
	>("../../clients/lsp/client.js");
	return { ...actual, createLSPClient };
});

// The footer write is not what these tests assert; stub it so a widget-state
// side effect cannot make the retire assertion pass or fail for the wrong
// reason.
const reconcileScanDiagnosticsMock = vi.fn().mockReturnValue(true);
vi.mock("../../clients/widget-state.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../clients/widget-state.js")
	>("../../clients/widget-state.js");
	return {
		...actual,
		reconcileScanDiagnostics: (...args: unknown[]) =>
			reconcileScanDiagnosticsMock(...args),
	};
});

let service: unknown;
vi.mock("../../clients/lsp/index.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../clients/lsp/index.js")
	>("../../clients/lsp/index.js");
	return { ...actual, getLSPService: () => service };
});

function makeServer(
	id: string,
	root: string,
	extensions: string[] = [".md"],
): Record<string, unknown> {
	return {
		id,
		name: id,
		extensions,
		root: async () => root,
		spawn: vi.fn(async () => ({ process: {}, source: "test" })),
	};
}

/** A push-only server that never publishes — silence, either earned or not. */
function makeSilentClient(serverId: string, root: string) {
	return {
		diagnosticsVersion: 0,
		getDiagnosticsVersionForPath: vi.fn(() => 0),
		isAlive: () => true,
		shutdown: async () => {},
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none",
		}),
		getOperationSupport: () => ({}),
		getAdvertisedCommands: () => [],
		getRawCapabilityKeys: () => [],
		getLaunchVariant: () => undefined,
		serverId,
		root,
		notify: { open: vi.fn(async () => {}) },
		waitForDiagnostics: vi.fn(async (_filePath: string, ms: number) => {
			await new Promise<void>((resolve) => {
				const t = setTimeout(resolve, ms);
				t.unref?.();
			});
			return undefined;
		}),
		getDiagnostics: vi.fn(() => []),
		getAllDiagnostics: vi.fn(() => new Map()),
	};
}

/** A server whose publication LANDS — an empty one still counts as an answer. */
function makeAnsweringClient(
	serverId: string,
	root: string,
	filePath: string,
	diagnostics: unknown[],
) {
	let version = 0;
	const stampsByPath = new Map<string, number>();
	return {
		...makeSilentClient(serverId, root),
		get diagnosticsVersion() {
			return version;
		},
		getDiagnosticsVersionForPath: vi.fn(
			(p: string) => stampsByPath.get(p) ?? 0,
		),
		waitForDiagnostics: vi.fn(async (p: string) => {
			version += 1;
			stampsByPath.set(p, version);
			return undefined;
		}),
		getDiagnostics: vi.fn(() => diagnostics),
		getAllDiagnostics: vi.fn(
			() =>
				new Map([
					[normalizeMapKey(filePath), { diags: diagnostics, ts: Date.now() }],
				]),
		),
	};
}

type RetireCall = {
	filePath: string;
	writeIndex?: number;
	coveredSources: string[];
};

/**
 * Drives the real tool with the real `RuntimeCoordinator` behind the hook —
 * the same wiring `index.ts` uses. Asserting on the coordinator's own state
 * rather than on a spy is what makes the F1 probe meaningful: the question is
 * not "did the hook fire" but "did an eslint-origin blocker survive".
 */
async function runTool(
	args: Record<string, unknown>,
	cwd: string,
	runtime: { retireInlineBlockerOnConfirmedClean: (...a: any[]) => boolean },
	retires: RetireCall[],
): Promise<any> {
	const { createLspDiagnosticsTool } =
		await import("../../tools/lsp-diagnostics.js");
	let token = 100;
	const tool = createLspDiagnosticsTool(
		() => ++token,
		({ filePath, writeIndex, coveredSources }) => {
			retires.push({ filePath, writeIndex, coveredSources });
			runtime.retireInlineBlockerOnConfirmedClean(
				filePath,
				writeIndex,
				coveredSources,
			);
		},
	);
	return (await tool.execute(
		"diag-1561",
		args,
		new AbortController().signal,
		null,
		{ cwd },
	)) as any;
}

async function freshService(): Promise<void> {
	const { LSPService } = await import("../../clients/lsp/index.js");
	service = new LSPService();
}

describe("#1561 lsp_diagnostics retires a stale inline blocker", () => {
	let tmp: string;
	let retires: RetireCall[];
	let runtime: InstanceType<
		typeof import("../../clients/runtime-coordinator.js").RuntimeCoordinator
	>;

	beforeEach(async () => {
		const { RuntimeCoordinator } =
			await import("../../clients/runtime-coordinator.js");
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		reconcileScanDiagnosticsMock.mockReset().mockReturnValue(true);
		retires = [];
		runtime = new RuntimeCoordinator();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-1561-"));
		process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS = "50";
		await freshService();
	});

	afterEach(async () => {
		delete process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS;
		await (service as { destroy?: () => Promise<void> })?.destroy?.();
		removeTempDirSync(tmp);
	});

	/** A clean Markdown file served by an answering marksman. */
	function arrangeCleanMarkdown(file: string, aux?: string): void {
		fs.writeFileSync(file, "# Example\n");
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md")
				? aux
					? [
							makeServer("marksman", tmp),
							{ ...makeServer(aux, tmp), role: "auxiliary" },
						]
					: [makeServer("marksman", tmp)]
				: [],
		);
		createLSPClient.mockImplementation(async (opts: { serverId: string }) =>
			makeAnsweringClient(opts.serverId, tmp, file, []),
		);
	}

	it("retires on a confirmed-clean single-file check (the live incident's mode)", async () => {
		const file = path.join(tmp, "README.md");
		arrangeCleanMarkdown(file);
		runtime.recordInlineBlockers(file, "🔴 STOP L320", 1, ["lsp"]);

		const result = await runTool(
			{ path: file, severity: "error", serverScope: "primary", waitMs: 10_000 },
			tmp,
			runtime,
			retires,
		);

		expect(result.details?.unconfirmed).toBe(false);
		expect(retires).toHaveLength(1);
		expect(path.resolve(retires[0].filePath)).toBe(path.resolve(file));
		// The token must be a real reservation, so the coordinator can order this
		// clean against the blocker's own dispatch token (#1198 inv. 1-2).
		expect(typeof retires[0].writeIndex).toBe("number");
		expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
	});

	it("F1: a NON-LSP-origin blocker survives an LSP-only clean", async () => {
		// The probe from review round 1. Inline blockers are built from every
		// runner (`dispatcher.ts` filters semantic === "blocking" across all of
		// them), so eslint, actionlint, biome-check and ast-grep SECURITY rules
		// land in the same map as type errors. A language-server check knows
		// nothing about any of them. Retiring on its say-so let an unfixed
		// `cors-wildcard` / `no-commented-credentials` finding become committable.
		const file = path.join(tmp, "README.md");
		arrangeCleanMarkdown(file);
		runtime.recordInlineBlockers(file, "🔴 STOP cors-wildcard", 1, [
			"ast-grep",
		]);

		const result = await runTool(
			{ path: file, severity: "error", serverScope: "primary", waitMs: 10_000 },
			tmp,
			runtime,
			retires,
		);

		// The verdict IS a confirmed clean, and the hook DOES fire — the check is
		// honest about the primary. It simply does not cover ast-grep…
		expect(result.details?.unconfirmed).toBe(false);
		expect(retires).toHaveLength(1);
		expect(retires[0].coveredSources).toEqual(["lsp"]);
		// …so the security-rule blocker stands, and still gates the commit.
		expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
		runtime.updateGitGuardStatus(false, "");
		expect(runtime.gitGuardHasBlockers).toBe(true);
	});

	it("F1: partial source coverage is not coverage", async () => {
		const file = path.join(tmp, "README.md");
		arrangeCleanMarkdown(file, "ast-grep");
		// Two sources; the check covers one of them. `every` is the right
		// quantifier here, not `some`.
		runtime.recordInlineBlockers(file, "🔴 STOP", 1, ["lsp", "eslint"]);

		await runTool(
			{ path: file, severity: "error", serverScope: "all", waitMs: 10_000 },
			tmp,
			runtime,
			retires,
		);

		expect(retires).toHaveLength(1);
		expect([...retires[0].coveredSources].sort()).toEqual(["ast-grep", "lsp"]);
		expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
	});

	it("F1: an all-scope check DOES retire an auxiliary-origin blocker it consulted", async () => {
		// The other side of the same coin — coverage must not be so narrow that a
		// genuinely covered blocker is pinned forever.
		const file = path.join(tmp, "README.md");
		arrangeCleanMarkdown(file, "ast-grep");
		runtime.recordInlineBlockers(file, "🔴 STOP", 1, ["ast-grep"]);

		await runTool(
			{ path: file, severity: "error", serverScope: "all", waitMs: 10_000 },
			tmp,
			runtime,
			retires,
		);

		expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
	});

	it("F1: a record with unknown provenance fails closed", async () => {
		const file = path.join(tmp, "README.md");
		arrangeCleanMarkdown(file);
		// No `sources` — a legacy record, or one whose diagnostics carried no
		// tool id. "We don't know what raised this" must not resolve to "an LSP
		// check can clear it".
		runtime.recordInlineBlockers(file, "🔴 STOP", 1);

		await runTool(
			{ path: file, severity: "error", serverScope: "primary", waitMs: 10_000 },
			tmp,
			runtime,
			retires,
		);

		expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
	});

	it("does NOT retire when the confirmed result still has a blocking finding", async () => {
		const file = path.join(tmp, "README.md");
		fs.writeFileSync(file, "# Example\n\n[missing](missing.md)\n");
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [makeServer("marksman", tmp)] : [],
		);
		createLSPClient.mockImplementation(async (opts: { serverId: string }) =>
			makeAnsweringClient(opts.serverId, tmp, file, [
				{
					severity: 1 as const,
					message: "Link to non-existent document",
					range: {
						start: { line: 2, character: 0 },
						end: { line: 2, character: 20 },
					},
					source: "marksman",
				},
			]),
		);
		runtime.recordInlineBlockers(file, "🔴 STOP", 1, ["lsp"]);

		await runTool(
			{ path: file, severity: "error", serverScope: "primary", waitMs: 10_000 },
			tmp,
			runtime,
			retires,
		);

		expect(retires).toEqual([]);
		expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
	});

	it("does NOT retire on an unconfirmed result (silence is not clean)", async () => {
		// A non-silent push-only straggler: nothing published, and the server is
		// not one whose silence can be trusted. #533/#570's whole point.
		const file = path.join(tmp, "main.rs");
		fs.writeFileSync(file, "fn main() {}\n");
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".rs") ? [makeServer("rust", tmp, [".rs"])] : [],
		);
		createLSPClient.mockImplementation(async (opts: { serverId: string }) =>
			makeSilentClient(opts.serverId, tmp),
		);
		runtime.recordInlineBlockers(file, "🔴 STOP", 1, ["lsp"]);

		const result = await runTool(
			{ path: file, severity: "error", serverScope: "primary", waitMs: 500 },
			tmp,
			runtime,
			retires,
		);

		expect(result.details?.unconfirmed).toBe(true);
		expect(retires).toEqual([]);
		expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
	});

	it("F5: an aux-coverage-gap partial verdict does NOT retire", async () => {
		// #1470/#1493 demote a file whose auxiliary was cut off or stayed silent
		// to "unconfirmed" while the primary's own line stays honest. That
		// demotion is what keeps the hook from firing on a partial answer. Pinned
		// here so anything that narrows the demotion cannot loosen the retire gate
		// as a silent side effect.
		const file = path.join(tmp, "README.md");
		fs.writeFileSync(file, "# Example\n");
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md")
				? [
						makeServer("marksman", tmp),
						{ ...makeServer("opengrep", tmp), role: "auxiliary" },
					]
				: [],
		);
		// The primary answers; the auxiliary never publishes for this content.
		createLSPClient.mockImplementation(async (opts: { serverId: string }) =>
			opts.serverId === "opengrep"
				? makeSilentClient(opts.serverId, tmp)
				: makeAnsweringClient(opts.serverId, tmp, file, []),
		);
		runtime.recordInlineBlockers(file, "🔴 STOP", 1, ["lsp"]);

		await runTool(
			{ path: file, severity: "error", serverScope: "all", waitMs: 500 },
			tmp,
			runtime,
			retires,
		);

		expect(retires).toEqual([]);
		expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
	});

	it("F4: a reconcile that throws is not evidence of clean", async () => {
		// Binds the catch in `reconcileWidgetFromLspResult`. Inverting its return
		// to `{confirmed: true, blocking: false}` must turn this red — otherwise
		// the guard is decoration.
		const file = path.join(tmp, "README.md");
		arrangeCleanMarkdown(file);
		reconcileScanDiagnosticsMock.mockImplementation(() => {
			throw new Error("footer write exploded");
		});
		runtime.recordInlineBlockers(file, "🔴 STOP", 1, ["lsp"]);

		await runTool(
			{ path: file, severity: "error", serverScope: "primary", waitMs: 10_000 },
			tmp,
			runtime,
			retires,
		);

		expect(retires).toEqual([]);
		expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
	});

	it("F5: a rejected reconcile does not retire an inline blocker", async () => {
		const file = path.join(tmp, "README.md");
		arrangeCleanMarkdown(file);
		reconcileScanDiagnosticsMock.mockReturnValue(false);
		runtime.recordInlineBlockers(file, "🔴 STOP", 1, ["lsp"]);

		await runTool(
			{ path: file, severity: "error", serverScope: "primary", waitMs: 10_000 },
			tmp,
			runtime,
			retires,
		);

		expect(retires).toEqual([]);
		expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
	});

	it("retires from the batch path too, so the sibling surface is not left behind", async () => {
		const files = ["a.md", "b.md"].map((name) => {
			const file = path.join(tmp, name);
			fs.writeFileSync(file, `# ${name}\n`);
			return file;
		});
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [makeServer("marksman", tmp)] : [],
		);
		createLSPClient.mockImplementation(async (opts: { serverId: string }) =>
			makeAnsweringClient(opts.serverId, tmp, files[0], []),
		);
		for (const file of files) {
			runtime.recordInlineBlockers(file, "🔴 STOP", 1, ["lsp"]);
		}

		await runTool(
			{
				paths: files,
				severity: "error",
				serverScope: "primary",
				waitMs: 10_000,
			},
			tmp,
			runtime,
			retires,
		);

		expect(retires.map((r) => path.resolve(r.filePath)).sort()).toEqual(
			files.map((f) => path.resolve(f)).sort(),
		);
		expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
	});
});
