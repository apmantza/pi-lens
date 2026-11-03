// flake-shape: real-process-spawn — the real JSON-RPC deadline and cross-evaluation service delivery require a real LSP child; lsp-spawn-heavy serializes it.
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const previousTimeout = vi.hoisted(() => {
	const previous = process.env.PI_LENS_LSP_NAV_REQUEST_TIMEOUT_MS;
	process.env.PI_LENS_LSP_NAV_REQUEST_TIMEOUT_MS = "150";
	return previous;
});

import { createLSPClient } from "../../../clients/lsp/client.js";
import { LspRequestTimeoutError } from "../../../clients/lsp/request-timeout-error.js";
import { LSPService } from "../../../clients/lsp/index.js";
import { stopLSP } from "../../../clients/lsp/launch.js";
import {
	normalizeLoggedPath,
	normalizeMapKey,
} from "../../../clients/path-utils.js";
import { readNdjsonRows } from "../../support/ndjson-rows.js";
import { setupTestEnvironment } from "../test-utils.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";

beforeEach(() => {
	vi.stubEnv("PI_LENS_TEST_MODE", "0");
});
afterEach(() => {
	vi.unstubAllEnvs();
	if (previousTimeout === undefined)
		delete process.env.PI_LENS_LSP_NAV_REQUEST_TIMEOUT_MS;
	else process.env.PI_LENS_LSP_NAV_REQUEST_TIMEOUT_MS = previousTimeout;
});

// #5219 r2: classify and persist the same aggregate outcome through the real sink.
async function lastAggregateMetadata(filePath: string) {
	const { flushLatencyLog, getLatencyLogPath } =
		await import("../../../clients/latency-logger.js");
	await flushLatencyLog();
	const result = readNdjsonRows(getLatencyLogPath());
	expect(result.skipped).toBe(0);
	return result.rows
		.filter(
			(row) =>
				row.phase === "lsp_diagnostics_aggregate" &&
				row.filePath === normalizeLoggedPath(normalizeMapKey(filePath)),
		)
		.at(-1)?.metadata;
}

it("real fake-server documentSymbol timeout is not an empty answer (#5211)", async () => {
	const fixture = setupTestEnvironment("pi-lens-navigation-timeout-");
	const filePath = path.join(fixture.tmpDir, "timeout-5211.ts");
	fs.writeFileSync(filePath, "const x = 1;");
	fs.writeFileSync(path.join(fixture.tmpDir, "package.json"), "{}");
	fs.writeFileSync(path.join(fixture.tmpDir, "tsconfig.json"), "{}");
	const proc = await spawnFakeLspServer({
		cwd: fixture.tmpDir,
		env: { ...process.env, FAKE_LSP_HANG_DOCUMENT_SYMBOL: "1" },
	});
	const client = await createLSPClient({
		serverId: "fake-document-symbol-timeout-5211",
		process: proc,
		root: fixture.tmpDir,
	});
	try {
		await client.notify.open(filePath, "const x = 1;", "typescript");
		await expect(client.documentSymbol(filePath)).rejects.toBeInstanceOf(
			LspRequestTimeoutError,
		);

		const service = new LSPService();
		// Use production server/root selection, retaining the client from the old
		// evaluation while the tool and its timeout class are re-evaluated (#5211).
		(
			service as unknown as { state: { clients: Map<string, unknown> } }
		).state.clients.set(
			`typescript:${normalizeMapKey(fixture.tmpDir)}`,
			client,
		);
		expect((await service.getClientForFile(filePath))?.client).toBe(client);
		vi.resetModules();
		const { getOpenDocumentSymbols } =
			await import("../../../clients/lsp-document-symbols.js");
		const { createLspNavigationTool } =
			await import("../../../tools/lsp-navigation.js");
		const { installLspService } =
			await import("../../support/lsp-service-seam.js");
		const freshTimeoutModule =
			await import("../../../clients/lsp/request-timeout-error.js");
		expect(freshTimeoutModule.LspRequestTimeoutError).not.toBe(
			LspRequestTimeoutError,
		);
		installLspService(service);
		let symbolError: unknown;
		try {
			await getOpenDocumentSymbols(filePath);
		} catch (err) {
			symbolError = err;
		}
		expect(freshTimeoutModule.isLspRequestTimeoutError(symbolError)).toBe(true);

		const result = await createLspNavigationTool(
			(flag) => flag === "lens-lsp",
		).execute(
			"real-document-symbol-timeout",
			{ operation: "documentSymbol", path: filePath },
			new AbortController().signal,
			null,
			{ cwd: fixture.tmpDir },
		);
		const envelope = JSON.parse(String(result.content[0]?.text)) as Record<
			string,
			unknown
		>;
		expect(result.isError).toBe(true);
		expect(envelope).toMatchObject({
			ok: false,
			status: "timeout",
			metadata: {
				method: "textDocument/documentSymbol",
			},
		});
		expect((envelope.metadata as { elapsedMs?: unknown }).elapsedMs).toEqual(
			expect.any(Number),
		);
	} finally {
		try {
			await client.shutdown();
		} catch {
			/* ignore */
		}
		await stopLSP(proc);
		fixture.cleanup();
	}
}, 5000);

// #5214 F4: definition deadlines must retain local recovery without hiding failure.
it.each([
	{ outcome: "hit", token: "greet", hangSymbols: false },
	{ outcome: "miss", token: "absent", hangSymbols: false },
	{ outcome: "both timeout", token: "greet", hangSymbols: true },
])(
	"definition timeout fallback $outcome (#5214 F4)",
	async ({ outcome, token, hangSymbols }) => {
		const fixture = setupTestEnvironment("pi-lens-definition-timeout-");
		const filePath = path.join(fixture.tmpDir, "definition.ts");
		const content = `function ${token}() {}\n`;
		fs.writeFileSync(filePath, content);
		fs.writeFileSync(path.join(fixture.tmpDir, "package.json"), "{}");
		fs.writeFileSync(path.join(fixture.tmpDir, "tsconfig.json"), "{}");
		const proc = await spawnFakeLspServer({
			cwd: fixture.tmpDir,
			env: {
				...process.env,
				FAKE_LSP_HANG_DEFINITION: "1",
				FAKE_LSP_HANG_DOCUMENT_SYMBOL: hangSymbols ? "1" : "0",
			},
		});
		const client = await createLSPClient({
			serverId: "fake-definition-timeout-5214",
			process: proc,
			root: fixture.tmpDir,
		});
		try {
			await client.notify.open(filePath, content, "typescript");
			const service = new LSPService();
			(
				service as unknown as { state: { clients: Map<string, unknown> } }
			).state.clients.set(
				`typescript:${normalizeMapKey(fixture.tmpDir)}`,
				client,
			);
			expect((await service.getClientForFile(filePath))?.client).toBe(client);
			const { createLspNavigationTool } =
				await import("../../../tools/lsp-navigation.js");
			const { installLspService } =
				await import("../../support/lsp-service-seam.js");
			installLspService(service);
			const result = await createLspNavigationTool(
				(flag) => flag === "lens-lsp",
			).execute(
				"definition-timeout-fallback",
				{ operation: "definition", path: filePath, line: 1, character: 11 },
				new AbortController().signal,
				null,
				{ cwd: fixture.tmpDir },
			);
			const text = String(result.content[0]?.text);
			const envelope = JSON.parse(text);
			if (outcome === "hit") {
				expect(result.isError).not.toBe(true);
				expect(envelope.status).toBe("success");
				expect(envelope.notes).toContain(
					"served from documentSymbol fallback; definition timed out.",
				);
				expect(envelope.locations).toMatchObject([
					{ filePath, range: { start: { line: 1, character: 1 } } },
				]);
				expect(text).toContain("definition timed out");
				expect(text).toContain("definition.ts");
				expect(result.details?.failureKind).toBe("fallback_after_timeout");
			} else {
				expect(result.isError).toBe(true);
				expect(envelope).toMatchObject({
					ok: false,
					status: "timeout",
					metadata: { method: "textDocument/definition" },
				});
			}
		} finally {
			try {
				await client.shutdown();
			} catch {
				/* ignore */
			}
			await stopLSP(proc);
			fixture.cleanup();
		}
	},
	5000,
);

// #5219 r2 T1: a push wait's own deadline is not a server answer.
it.each([
	"push-silent",
	"push-stale",
	"push-empty",
	"pull-timeout",
	"pull-empty",
	"pull-cleared",
])(
	"real aggregate answer classification %s",
	async (mode) => {
		const fixture = setupTestEnvironment("pi-lens-silent-push-");
		const filePath = path.join(fixture.tmpDir, "silent.ts");
		fs.writeFileSync(filePath, "const x = 1;");
		fs.writeFileSync(path.join(fixture.tmpDir, "package.json"), "{}");
		fs.writeFileSync(path.join(fixture.tmpDir, "tsconfig.json"), "{}");
		const proc = await spawnFakeLspServer({
			cwd: fixture.tmpDir,
			env: {
				...process.env,
				FAKE_LSP_NO_DIAGNOSTIC_PROVIDER: mode.startsWith("push") ? "1" : "0",
				FAKE_LSP_PUSH_DIAGNOSTIC: mode === "push-stale" ? "1" : "0",
				FAKE_LSP_PUBLISH_SEQUENCE: mode === "push-empty" ? "empty" : "",
				FAKE_LSP_RESPOND_PULL_WITH:
					mode === "pull-timeout"
						? "timeout"
						: mode === "pull-cleared"
							? "auto"
							: "empty",
			},
		});
		const client = await createLSPClient({
			serverId: "typescript",
			process: proc,
			root: fixture.tmpDir,
		});
		const { _setServersForFileForTests } =
			await import("../../../clients/lsp/config.js");
		const { LSPService: FreshService } =
			await import("../../../clients/lsp/index.js");
		const service = new FreshService();
		try {
			await client.notify.open(filePath, "const x = 1;", "typescript");
			(
				service as unknown as { state: { clients: Map<string, unknown> } }
			).state.clients.set(
				`typescript:${normalizeMapKey(fixture.tmpDir)}`,
				client,
			);
			_setServersForFileForTests(
				() =>
					[
						{
							id: "typescript",
							name: "typescript",
							extensions: [".ts"],
							root: async () => fixture.tmpDir,
							spawn: async () => {
								throw new Error("cached client required");
							},
						},
					] as never,
			);
			if (mode === "push-empty")
				await client.waitForDiagnostics(filePath, 1000);
			if (mode === "push-stale" || mode === "pull-cleared") {
				expect((await service.getDiagnostics(filePath)).length).toBeGreaterThan(
					0,
				);
				await client.notify.change(
					filePath,
					mode === "pull-cleared" ? "fake-lsp-clean" : "const x = 2;",
				);
			}
			expect(await service.getDiagnostics(filePath)).toEqual([]);
			expect(service.getDiagnosticsHealth(filePath)?.failureKind).toBe(
				mode.endsWith("empty") || mode === "pull-cleared"
					? "ok_empty"
					: "timeout",
			);
			expect(service.getDiagnosticsHealth(filePath)?.partialTimeout).toBe(
				false,
			);
			expect(await lastAggregateMetadata(filePath)).toMatchObject({
				failureKind:
					mode.endsWith("empty") || mode === "pull-cleared"
						? "ok_empty"
						: "timeout",
				partialTimeout: false,
			});
			if (mode === "pull-cleared")
				expect(service.getLastKnownDiagnostics(filePath)).toBeUndefined();
			if (mode === "push-stale")
				expect(
					service.getLastKnownDiagnostics(filePath)?.length,
				).toBeGreaterThan(0);
		} finally {
			_setServersForFileForTests(undefined);
			await client.shutdown();
			await stopLSP(proc);
			fixture.cleanup();
		}
	},
	5000,
);

// #5219 r2 T2: use the real aggregate's success-plus-partial state.
it.each([false, true])(
	"real partial diagnostics disclose the unanswered server in navigation (empty=%s)",
	async (empty) => {
		const fixture = setupTestEnvironment("pi-lens-partial-diagnostics-");
		const filePath = path.join(fixture.tmpDir, "partial.ts");
		fs.writeFileSync(filePath, "const x = 1;");
		fs.writeFileSync(path.join(fixture.tmpDir, "package.json"), "{}");
		fs.writeFileSync(path.join(fixture.tmpDir, "tsconfig.json"), "{}");
		const { _setServersForFileForTests } =
			await import("../../../clients/lsp/config.js");
		const procs = [];
		const clients = [];
		const { LSPService: FreshService } =
			await import("../../../clients/lsp/index.js");
		const service = new FreshService();
		try {
			for (const id of ["typescript", "pyright"]) {
				const proc = await spawnFakeLspServer({
					cwd: fixture.tmpDir,
					env: {
						...process.env,
						FAKE_LSP_NO_DIAGNOSTIC_PROVIDER: id === "typescript" ? "1" : "0",
						FAKE_LSP_DIAGNOSTIC_MESSAGE: "real aggregate diagnostic",
					},
				});
				procs.push(proc);
				const client = await createLSPClient({
					serverId: id,
					process: proc,
					root: fixture.tmpDir,
				});
				clients.push(client);
				await client.notify.open(filePath, "const x = 1;", "typescript");
				(
					service as unknown as { state: { clients: Map<string, unknown> } }
				).state.clients.set(`${id}:${normalizeMapKey(fixture.tmpDir)}`, client);
			}
			_setServersForFileForTests(
				() =>
					["typescript", "pyright"].map((id) => ({
						id,
						name: id,
						extensions: [".ts"],
						root: async () => fixture.tmpDir,
						spawn: async () => {
							throw new Error("cached clients required");
						},
					})) as never,
			);
			const { installLspService } =
				await import("../../support/lsp-service-seam.js");
			const { createLspNavigationTool } =
				await import("../../../tools/lsp-navigation.js");
			if (empty) {
				expect((await service.getDiagnostics(filePath)).length).toBeGreaterThan(
					0,
				);
				fs.writeFileSync(filePath, "fake-lsp-clean");
				for (const client of clients)
					await client.notify.change(filePath, "fake-lsp-clean");
			}
			installLspService(service);
			const result = await createLspNavigationTool(
				(flag) => flag === "lens-lsp",
			).execute(
				"partial-real",
				{ operation: "workspaceDiagnostics", path: filePath },
				new AbortController().signal,
				null,
				{ cwd: fixture.tmpDir },
			);
			expect(service.getDiagnosticsHealth(filePath)?.failureKind).toBe(
				empty ? "ok_empty" : "success",
			);
			expect(service.getDiagnosticsHealth(filePath)?.partialTimeout).toBe(true);
			expect(await lastAggregateMetadata(filePath)).toMatchObject({
				failureKind: empty ? "ok_empty" : "success",
				partialTimeout: true,
			});
			expect(result.isError).not.toBe(true);
			if (empty) {
				expect(result.details?.resultCount).toBe(0);
				expect(
					service.getLastKnownDiagnostics(filePath)?.length,
				).toBeGreaterThan(0);
			} else {
				expect(String(result.content[0]?.text)).toContain(
					"real aggregate diagnostic",
				);
			}
			expect(String(result.content[0]?.text)).toContain(
				"LSP diagnostics timed out",
			);
		} finally {
			_setServersForFileForTests(undefined);
			for (const client of clients) await client.shutdown();
			for (const proc of procs) await stopLSP(proc);
			fixture.cleanup();
		}
	},
	8000,
);
