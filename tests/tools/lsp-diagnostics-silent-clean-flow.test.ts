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
import { clearWidgetState } from "../../clients/widget-state.js";
import { removeTempDirSync } from "../clients/test-utils.js";
import { installLspService } from "../support/lsp-service-seam.js";
import { _setServersForFileForTests } from "../../clients/lsp/config.js";

beforeEach(() => {
	_setServersForFileForTests(getServersForFileWithConfig);
	clearWidgetState();
});
afterEach(() => {
	clearWidgetState();
});

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../clients/lsp/client.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../clients/lsp/client.js")
	>("../../clients/lsp/client.js");
	return { ...actual, createLSPClient };
});

let service: unknown;
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
		notify: {
			announceCreated: () => undefined,
			open: vi.fn(async () => {}),
		},
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
	service = installLspService(new LSPService());
}

describe("#1253 lsp_diagnostics end-to-end silent-clean confirmation", () => {
	let tmp: string;

	beforeEach(async () => {
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
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

/** What the stub server publishes for the content it last received (#5128). */
type StubBehaviour = {
	/** `undefined` = nothing published (the server is silent for this content). */
	publishFor: (content: string) => unknown[] | undefined;
};

/**
 * A push-only custom server with no pull provider. It publishes per
 * `behaviour`; when it has nothing to publish it waits like `makeSilentClient`.
 */
function makeStubClient(root: string, behaviour: StubBehaviour) {
	const client = makeSilentClient("groovy-stub", root);
	const silentWait = client.waitForDiagnostics as (
		filePath: string,
		ms: number,
	) => Promise<undefined>;
	let version = 0;
	let delivered = "";
	const stampsByPath = new Map<string, number>();
	const cache = new Map<string, { diags: unknown[]; ts: number }>();
	client.getDiagnosticsVersionForPath = vi.fn(
		(filePath: string) => stampsByPath.get(filePath) ?? 0,
	) as never;
	client.notify.open = vi.fn(async (filePath: string, content: string) => {
		delivered = content;
		cache.delete(normalizeMapKey(filePath));
	}) as never;
	client.waitForDiagnostics = vi.fn(async (filePath: string, ms: number) => {
		const diags = behaviour.publishFor(delivered);
		if (diags === undefined) return silentWait(filePath, ms);
		version += 1;
		stampsByPath.set(filePath, version);
		cache.set(normalizeMapKey(filePath), { diags, ts: Date.now() });
		return undefined;
	}) as never;
	client.getDiagnostics = vi.fn(
		(filePath: string) => cache.get(normalizeMapKey(filePath))?.diags ?? [],
	) as never;
	client.getAllDiagnostics = vi.fn(() => cache) as never;
	return client;
}

const STUB_FINDING = {
	severity: 1 as const,
	message: "stub syntax error",
	range: {
		start: { line: 0, character: 0 },
		end: { line: 0, character: 5 },
	},
	source: "stub",
};

/**
 * #5128 (found in #5123): a custom push-only server that has not published by
 * the end of the first-contact wait was latched `diagnosticsUnsupported` for the
 * session. The tool reported such a file as `unsupported` ("navigation-only")
 * and a later publish never cleared the latch, so a server that publishes only
 * for files with errors (groovy-language-server) read as unsupported forever,
 * and one report listed a finding beside `unsupported=1`.
 *
 * These cases drive the REAL `lsp_diagnostics` tool and the real LSPService; only
 * the client transport is faked. The publish reaches the service through the
 * `onDiagnosticsPublished` callback `createLSPClient` is handed, which is the
 * call the real client makes when a `publishDiagnostics` frame lands.
 */
describe("#5128 lsp_diagnostics: the first-contact latch for a custom push-only server", () => {
	let tmp: string;
	let file: string;
	let behaviour: StubBehaviour;

	/** What the real client calls when a `publishDiagnostics` frame lands. */
	function serverPublishes(): void {
		createLSPClient.mock.calls[0][0].onDiagnosticsPublished("groovy-stub");
	}

	async function check(content: string): Promise<any> {
		fs.writeFileSync(file, content);
		return await runTool(
			{ paths: [file], severity: "all", serverScope: "primary", waitMs: 5000 },
			tmp,
		);
	}

	beforeEach(async () => {
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5128-"));
		file = path.join(tmp, "Clean.groovy");
		// Keep the silent server's real wait short; the verdict under test does
		// not depend on the budget.
		process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS = "50";
		behaviour = { publishFor: () => undefined };
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".groovy")
				? [
						{
							...makeServer("groovy-stub", tmp),
							extensions: [".groovy"],
							custom: true,
						},
					]
				: [],
		);
		createLSPClient.mockImplementation(async () =>
			makeStubClient(tmp, behaviour),
		);
		await freshService();
	});

	afterEach(async () => {
		delete process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS;
		await (service as { destroy?: () => Promise<void> })?.destroy?.();
		removeTempDirSync(tmp);
	});

	it("reads a custom server that never published as unconfirmed, not unsupported", async () => {
		const first = await check("class Clean {}\n");
		const second = await check("class Clean { int x }\n");

		for (const result of [first, second]) {
			expect(result.details?.outcomeCounts).toMatchObject({
				inconclusive: 1,
				unsupported: 0,
				clean: 0,
			});
			expect(result.details?.navigationOnlyFiles).toBeUndefined();
		}
		expect(String(second.content[0]?.text)).toContain("inconclusive=1");
	});

	it("recovers to the real outcome when the server publishes after the latch", async () => {
		await check("class Clean {}\n");
		behaviour.publishFor = () => [];
		serverPublishes();

		const after = await check("class Clean { int x }\n");

		expect(after.details?.outcomeCounts).toMatchObject({
			clean: 1,
			inconclusive: 0,
			unsupported: 0,
		});
	});

	it("reports a dirty-only publisher's finding as findings, and its clean files as unconfirmed", async () => {
		behaviour.publishFor = (content) =>
			content.includes("BROKEN") ? [STUB_FINDING] : undefined;
		const clean = await check("class Clean {}\n");
		expect(clean.details?.outcomeCounts).toMatchObject({ inconclusive: 1 });

		// The latch skips the wait for this write; the publish lands afterwards.
		await check("BROKEN\n");
		serverPublishes();
		const dirty = await check("BROKEN again\n");

		expect(dirty.details?.totalDiagnostics).toBe(1);
		expect(dirty.details?.outcomeCounts).toMatchObject({
			findings: 1,
			unsupported: 0,
		});
		expect(String(dirty.content[0]?.text)).toContain("stub syntax error");

		const cleanAgain = await check("class Clean {}\n");
		expect(cleanAgain.details?.outcomeCounts).toMatchObject({
			inconclusive: 1,
			unsupported: 0,
			clean: 0,
		});
	});
});
