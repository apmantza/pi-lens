/**
 * #1253 END-TO-END: the silent-clean confirmation must survive the whole way
 * from `LSPService.touchFile`'s capability gate (#799/#814) to the rendered
 * `lsp_diagnostics` outcome.
 *
 * The rest of the suite covers each half of that boundary separately —
 * `tests/clients/lsp/silent-clean-confirm.test.ts` drives the REAL service and
 * asserts the touch result, while `tests/tools/lsp-diagnostics.test.ts` drives
 * the REAL tool against a MOCKED `touchFile` that hands back canned
 * confirmation metadata. Neither can catch a mismatch in the middle: if the
 * service stopped emitting the metadata, or the tool started asking for a shape
 * the service never produces, both suites would still pass while a clean
 * Markdown file reported `inconclusive` in production (exactly the #1253
 * report). These tests wire the real service to the real tool with only the
 * server registry and the client transport faked, so the confirmation has to
 * actually flow.
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
		// Mirrors the real implementation (first non-auxiliary server), reading
		// the faked registry above rather than the module-local original.
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
	role?: "auxiliary",
): Record<string, unknown> {
	return {
		id,
		name: id,
		extensions: [".md"],
		role,
		root: async () => root,
		spawn: vi.fn(async () => ({ process: {}, source: "test" })),
	};
}

/**
 * A push-only server that never publishes — a clean file under marksman.
 *
 * Both publication axes are present and NEITHER advances. That is the whole point
 * of this double, and stating it explicitly matters: with the properties absent,
 * the pre-notify baseline is `undefined`, so #1533's evidence check reads "no
 * publication" for the same reason it reads it for a genuinely silent server —
 * the verdict would come from the fixture's omission rather than from modelled
 * behavior (defect shape 7). Silence here is earned, not inferred from a gap.
 *
 * #1531: the axis the evidence check actually reads is the PER-PATH stamp, so a
 * double that answers only on `diagnosticsVersion` exercises just the fail-closed
 * branch. This one answers on both, and returns 0 on both forever.
 */
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

/**
 * A server that answers promptly (found something, or a confirmed empty).
 *
 * #1533: "answers" means a PUBLICATION LANDED, which advances the client's version
 * state on a real client (`client.ts` `recordBinding`). An empty publication counts
 * — that is exactly what makes a confirmed-clean scanner distinguishable from one
 * that never spoke. The accessors are declared on THIS object rather than inherited
 * through the spread of `makeSilentClient`, because a spread would evaluate a getter
 * once and freeze it; the bump has to be observable after the wait resolves.
 *
 * #1531: both axes advance together, as production does — the client-global counter
 * and the PER-PATH stamp recording that counter's value for this file. The per-path
 * stamp is the one the evidence check reads, so bumping only the global counter
 * would leave this "answering" double indistinguishable from a silent one.
 */
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
			(path: string) => stampsByPath.get(path) ?? 0,
		),
		waitForDiagnostics: vi.fn(async (path: string) => {
			version += 1;
			stampsByPath.set(path, version);
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

async function runTool(
	args: Record<string, unknown>,
	cwd: string,
): Promise<any> {
	const { createLspDiagnosticsTool } =
		await import("../../tools/lsp-diagnostics.js");
	return (await createLspDiagnosticsTool().execute(
		"diag-1253",
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

describe("#1253 lsp_diagnostics end-to-end silent-clean confirmation", () => {
	let tmp: string;

	beforeEach(async () => {
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		reconcileScanDiagnosticsMock.mockReset().mockReturnValue(true);
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-1253-e2e-"));
		// Keep the silent server's real wait short — the gate under test is
		// unchanged by the budget (see silent-clean-confirm.test.ts).
		process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS = "50";
		await freshService();
	});

	afterEach(async () => {
		delete process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS;
		await (service as { destroy?: () => Promise<void> })?.destroy?.();
		removeTempDirSync(tmp);
	});

	it.each(["primary", "all"] as const)(
		"reports a clean Markdown file as clean for serverScope %s",
		async (serverScope) => {
			const file = path.join(tmp, "README.md");
			fs.writeFileSync(file, "# Example\n\nNo broken links.\n");
			getServersForFileWithConfig.mockImplementation((fp: string) =>
				fp.endsWith(".md") ? [makeServer("marksman", tmp)] : [],
			);
			createLSPClient.mockImplementation(async (opts: { serverId: string }) =>
				makeSilentClient(opts.serverId, tmp),
			);

			const result = await runTool(
				{ paths: [file], severity: "all", serverScope, waitMs: 10_000 },
				tmp,
			);

			expect(result.details?.outcomeCounts).toMatchObject({
				clean: 1,
				inconclusive: 0,
			});
			expect(result.details?.cleanFiles).toBe(1);
			expect(result.details?.unconfirmedFiles).toBe(0);
		},
	);

	it("counts a batch of clean Markdown files as clean, none inconclusive", async () => {
		const files = ["a.md", "b.md", "c.md", "d.md"].map((name) => {
			const file = path.join(tmp, name);
			fs.writeFileSync(file, `# ${name}\n`);
			return file;
		});
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [makeServer("marksman", tmp)] : [],
		);
		createLSPClient.mockImplementation(async (opts: { serverId: string }) =>
			makeSilentClient(opts.serverId, tmp),
		);

		const result = await runTool(
			{ paths: files, severity: "all", serverScope: "primary", waitMs: 10_000 },
			tmp,
		);

		expect(result.details?.outcomeCounts).toMatchObject({
			clean: 4,
			inconclusive: 0,
		});
	});

	it("serverScope 'all': marksman silent + auxiliary answered is still clean", async () => {
		const file = path.join(tmp, "README.md");
		fs.writeFileSync(file, "# Example\n");
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md")
				? [makeServer("marksman", tmp), makeServer("typos", tmp, "auxiliary")]
				: [],
		);
		createLSPClient.mockImplementation(async (opts: { serverId: string }) =>
			opts.serverId === "typos"
				? makeAnsweringClient("typos", tmp, file, [])
				: makeSilentClient(opts.serverId, tmp),
		);

		const result = await runTool(
			{ paths: [file], severity: "all", serverScope: "all", waitMs: 10_000 },
			tmp,
		);

		expect(result.details?.outcomeCounts).toMatchObject({
			clean: 1,
			inconclusive: 0,
		});
	});

	it("keeps a real Marksman finding as a finding", async () => {
		const file = path.join(tmp, "README.md");
		fs.writeFileSync(file, "# Example\n\n[missing](missing.md)\n");
		const finding = {
			severity: 2 as const,
			message: "Link to non-existent document",
			range: {
				start: { line: 2, character: 0 },
				end: { line: 2, character: 20 },
			},
			source: "marksman",
		};
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [makeServer("marksman", tmp)] : [],
		);
		createLSPClient.mockImplementation(async () =>
			makeAnsweringClient("marksman", tmp, file, [finding]),
		);

		const result = await runTool(
			{
				paths: [file],
				severity: "all",
				serverScope: "primary",
				waitMs: 10_000,
			},
			tmp,
		);

		expect(result.details?.totalDiagnostics).toBe(1);
		expect(result.details?.outcomeCounts).toMatchObject({
			findings: 1,
			clean: 0,
			inconclusive: 0,
		});
	});

	it("a failed notify write stays inconclusive (no manufactured clean)", async () => {
		const prev = process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
		process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = "50";
		try {
			const file = path.join(tmp, "README.md");
			fs.writeFileSync(file, "# Example\n");
			getServersForFileWithConfig.mockImplementation((fp: string) =>
				fp.endsWith(".md") ? [makeServer("marksman", tmp)] : [],
			);
			createLSPClient.mockImplementation(async (opts: { serverId: string }) => {
				const client = makeSilentClient(opts.serverId, tmp);
				// The write never lands, so the server's silence proves nothing.
				client.notify.open = vi.fn(() => new Promise(() => {})) as never;
				return client;
			});

			const result = await runTool(
				{
					paths: [file],
					severity: "all",
					serverScope: "primary",
					waitMs: 10_000,
				},
				tmp,
			);

			expect(result.details?.outcomeCounts).toMatchObject({
				clean: 0,
				inconclusive: 1,
			});
		} finally {
			if (prev === undefined) delete process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
			else process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = prev;
		}
	});

	it("a non-silent push-only straggler stays inconclusive", async () => {
		const file = path.join(tmp, "main.rs");
		fs.writeFileSync(file, "fn main() {}\n");
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".rs")
				? [{ ...makeServer("rust", tmp), extensions: [".rs"] }]
				: [],
		);
		createLSPClient.mockImplementation(async (opts: { serverId: string }) =>
			makeSilentClient(opts.serverId, tmp),
		);

		const result = await runTool(
			{ paths: [file], severity: "all", serverScope: "primary", waitMs: 500 },
			tmp,
		);

		expect(result.details?.outcomeCounts).toMatchObject({
			clean: 0,
			inconclusive: 1,
		});
	});
});
