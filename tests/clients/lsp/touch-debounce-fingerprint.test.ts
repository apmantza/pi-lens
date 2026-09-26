/**
 * #3480: the touch debounce must tell two long documents apart when they
 * differ only in the middle.
 *
 * Recurrence this file prevents: `shouldSkipNotify` compared a length + first
 * 48 + last 48 chars fingerprint, so a same-length middle edit of a >96-char
 * file inside the 1500 ms debounce window was skipped with nothing recorded,
 * and the server kept answering from the previous content.
 *
 * Production chain: the REAL `LSPService.touchFile` -> the REAL
 * `handleNotifyOpen` notify queue -> a mock `MessageConnection` (the process
 * boundary). Only the server registry and client construction are doubled.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as clientModule from "../../../clients/lsp/client.js";
import { fingerprintDocumentContent } from "../../../clients/lsp/document-drift.js";
import { LSPService } from "../../../clients/lsp/index.js";
import { createMockState } from "./mock-client-state.js";

const { getServersForFileWithConfig, createLSPClient } = vi.hoisted(() => ({
	getServersForFileWithConfig: vi.fn(),
	createLSPClient: vi.fn(),
}));

vi.mock("../../../clients/lsp/config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/config.js")>()),
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
// #3480 round 1: count the fingerprints `touchFile` computes. Wrapped, not
// replaced: every other export is the real module.
vi.mock("../../../clients/lsp/document-drift.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../../clients/lsp/document-drift.js")
		>();
	return {
		...actual,
		fingerprintDocumentContent: vi.fn(actual.fingerprintDocumentContent),
	};
});
vi.mock("../../../clients/lsp/client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/client.js")>()),
	createLSPClient,
}));

const ROOT = "/repo";
const FILE = "/repo/long.ts";
const HEAD = `// ${"h".repeat(60)}\n`;
const TAIL = `// ${"t".repeat(60)}\n`;
const A = `${HEAD}const x = 1;\n${TAIL}`;
const B = `${HEAD}const x = 2;\n${TAIL}`;

async function setup() {
	const state = createMockState({ root: ROOT, serverId: "typescript" });
	const client = {
		serverId: "typescript",
		root: ROOT,
		customServer: false,
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
		diagnosticsVersion: 0,
		getDiagnosticsVersionForPath: vi.fn(() => 0),
		getDiagnostics: vi.fn(() => []),
		getAllDiagnostics: vi.fn(() => new Map()),
		getDiagnosticBinding: vi.fn(() => undefined),
		notify: {
			open: (
				filePath: string,
				content: string,
				languageId: string,
				preserveDiagnostics?: boolean,
				silent?: boolean,
				saved?: boolean,
			) =>
				clientModule.handleNotifyOpen(
					state,
					filePath,
					content,
					languageId,
					preserveDiagnostics,
					silent,
					saved,
				),
			change: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		},
		pingLiveness: vi.fn().mockResolvedValue(true),
		waitForDiagnostics: vi.fn(async () => {}),
	};
	getServersForFileWithConfig.mockReturnValue([
		{
			id: "typescript",
			name: "typescript",
			extensions: [".ts"],
			root: async () => ROOT,
			spawn: vi.fn(async () => ({ process: {}, source: "test" })),
		},
	]);
	createLSPClient.mockResolvedValue(client);
	const service = new LSPService();
	const texts = () =>
		vi
			.mocked(state.connection.sendNotification)
			.mock.calls.filter(([method]) => /didOpen|didChange/.test(String(method)))
			.map(([method, params]) => {
				const p = params as {
					textDocument?: { text?: string };
					contentChanges?: Array<{ text: string }>;
				};
				return `${String(method).replace("textDocument/", "")}:${
					p.textDocument?.text ?? p.contentChanges?.at(-1)?.text
				}`;
			});
	return { service, texts };
}

describe("#3480 — touch debounce fingerprint covers the whole document", () => {
	beforeEach(() => {
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends a same-length middle edit of a long file inside the debounce window", async () => {
		expect(B.length).toBe(A.length);
		expect(A.length).toBeGreaterThan(96);
		const { service, texts } = await setup();

		await service.touchFile(FILE, A, { diagnostics: "none", source: "test" });
		await service.touchFile(FILE, B, { diagnostics: "none", source: "test" });

		expect(texts()).toEqual([`didOpen:${A}`, `didChange:${B}`]);
	});

	// #3480 round 1 N1: one whole-content hash per touch, not one per debounce
	// check and per mark (each a sha256 of up to the whole file).
	it("fingerprints the content once per touch", async () => {
		const { service } = await setup();
		await service.touchFile(FILE, A, { diagnostics: "none", source: "test" });
		const fingerprint = vi.mocked(fingerprintDocumentContent);
		fingerprint.mockClear();

		await service.touchFile(FILE, B, { diagnostics: "none", source: "test" });

		expect(fingerprint.mock.calls.filter(([c]) => c === B)).toHaveLength(1);
	});

	it("still skips a repeat touch of identical long content inside the window", async () => {
		const { service, texts } = await setup();

		await service.touchFile(FILE, A, { diagnostics: "none", source: "test" });
		await service.touchFile(FILE, A, { diagnostics: "none", source: "test" });

		expect(texts()).toEqual([`didOpen:${A}`]);
	});
});
