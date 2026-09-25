/**
 * #3405: `textDocument/didSave` is sent on the post-write sync, capability-gated.
 *
 * Recurrence this file prevents: the client advertised
 * `synchronization.didSave` in `CLIENT_CAPABILITIES` (since #278, for the
 * OmniSharp null-deref class) and NO caller ever emitted the notification, so a
 * server whose diagnose pass is save-triggered could not answer through pi-lens
 * at all. Expert is the measured member — `expert-lsp/expert@6bbad8c`
 * `apps/expert/lib/expert/state.ex:385-389` declares `save: true`, and `:243-257`
 * makes didSave its only whole-project `schedule_compile` trigger — which is why
 * #3402's lane-B expert row collected 0 diagnostics at both 1500 and 8000 ms
 * after a successful `mix compile`.
 *
 * The contract is upstream's, not the issue's paraphrase:
 * `microsoft/vscode-languageserver-node@4f782ceac1b4444d335a32561bda0ded305c401e`
 * `protocol/src/common/protocol.ts:1751-1755` — "If present save notifications
 * are sent to the server. If omitted the notification should not be sent." —
 * `:1038-1043` for `SaveOptions.includeText`, and `:1909-1920` for
 * `DidSaveTextDocumentParams` (`textDocument` plus an OPTIONAL `text`).
 *
 * Screens (AGENTS.md's ten): **all-mocks** — the only double is
 * `state.connection`, the JSON-RPC transport, which is the true process
 * boundary; the negotiation, the notify queue and the send gates are the real
 * production functions, and the last describe re-proves the same behaviour over
 * a real stdio server process with no double at all. **implementation mirror** —
 * the assertions read the wire frames a server receives (method order, params),
 * never the client's own state. **invisible skip** — no `skipIf` anywhere.
 * **loose bound** — every case pins the exact method sequence, not "didSave was
 * called at least once".
 */

import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	createLSPClient,
	handleNotifyOpen,
	type LSPClientState,
} from "../../../clients/lsp/client.js";
import { stopLSP } from "../../../clients/lsp/launch.js";
import {
	negotiateSaveOptions,
	TEXT_DOCUMENT_SYNC_KIND_INCREMENTAL,
} from "../../../clients/lsp/sync-kind.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";
import { createMockState } from "./mock-client-state.js";

const TEST_FILE = path.join(os.tmpdir(), "pi-lens-did-save.ts");
const TEST_URI = pathToFileURL(TEST_FILE).href;

/** The notification methods the transport was handed, in order. */
function sentMethods(state: LSPClientState): string[] {
	return vi
		.mocked(state.connection.sendNotification)
		.mock.calls.map((call) => String(call[0]));
}

function sentParams(state: LSPClientState, method: string): unknown {
	const call = vi
		.mocked(state.connection.sendNotification)
		.mock.calls.find((entry) => String(entry[0]) === method);
	return call?.[1];
}

describe("negotiateSaveOptions — the `save` half of textDocumentSync (#3405)", () => {
	it("reads a bare `save: true` as save-declaring with no text", () => {
		expect(
			negotiateSaveOptions({
				textDocumentSync: { openClose: true, save: true },
			}),
		).toEqual({ includeText: false });
	});

	it("reads `save: { includeText: true }` as asking for the document text", () => {
		expect(
			negotiateSaveOptions({
				textDocumentSync: { save: { includeText: true } },
			}),
		).toEqual({ includeText: true });
	});

	it("reads `save: {}` as declaring save without the text", () => {
		expect(negotiateSaveOptions({ textDocumentSync: { save: {} } })).toEqual({
			includeText: false,
		});
	});

	it("treats an omitted `save` as a server that must not receive didSave", () => {
		expect(
			negotiateSaveOptions({
				textDocumentSync: {
					openClose: true,
					change: TEXT_DOCUMENT_SYNC_KIND_INCREMENTAL,
				},
			}),
		).toBeUndefined();
	});

	it("treats an explicit `save: false` as a refusal", () => {
		expect(
			negotiateSaveOptions({ textDocumentSync: { save: false } }),
		).toBeUndefined();
	});

	it("treats the legacy numeric textDocumentSync shape as declaring no save", () => {
		// Pre-3.0 servers answer with the bare change kind; it carries no save
		// field, so per upstream the notification must not be sent.
		expect(negotiateSaveOptions({ textDocumentSync: 2 })).toBeUndefined();
		expect(negotiateSaveOptions({})).toBeUndefined();
		expect(negotiateSaveOptions(undefined)).toBeUndefined();
	});
});

describe("textDocument/didSave on a declared save (#3405)", () => {
	let state: LSPClientState;

	beforeEach(() => {
		state = createMockState();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("follows the first didOpen with didSave when the server declared save", async () => {
		state.saveOptions = { includeText: false };
		await handleNotifyOpen(
			state,
			TEST_FILE,
			"const x = 1;\n",
			"typescript",
			false,
			true,
			true,
		);
		expect(sentMethods(state)).toEqual([
			"textDocument/didOpen",
			"textDocument/didSave",
		]);
		// Upstream's DidSaveTextDocumentParams: the identifier, and `text` only
		// when includeText was asked for.
		expect(sentParams(state, "textDocument/didSave")).toEqual({
			textDocument: { uri: TEST_URI },
		});
	});

	it("carries the document text when the server asked for includeText", async () => {
		state.saveOptions = { includeText: true };
		await handleNotifyOpen(
			state,
			TEST_FILE,
			"const x = 1;\n",
			"typescript",
			false,
			true,
			true,
		);
		expect(sentParams(state, "textDocument/didSave")).toEqual({
			textDocument: { uri: TEST_URI },
			text: "const x = 1;\n",
		});
	});

	it("follows a didChange with didSave when the document is already open", async () => {
		state.saveOptions = { includeText: false };
		await handleNotifyOpen(
			state,
			TEST_FILE,
			"const x = 1;\n",
			"typescript",
			false,
			true,
			true,
		);
		vi.mocked(state.connection.sendNotification).mockClear();
		await handleNotifyOpen(
			state,
			TEST_FILE,
			"const x = 2;\n",
			"typescript",
			false,
			true,
			true,
		);
		expect(sentMethods(state)).toEqual([
			"textDocument/didChange",
			"textDocument/didSave",
		]);
	});

	it("sends no didSave to a server that declared no save", async () => {
		// The gate that makes this spec-correct rather than merely cautious.
		expect(state.saveOptions).toBeUndefined();
		await handleNotifyOpen(
			state,
			TEST_FILE,
			"const x = 1;\n",
			"typescript",
			false,
			true,
			true,
		);
		expect(sentMethods(state)).toEqual(["textDocument/didOpen"]);
	});

	it("sends no didSave when the caller did not declare the touch a save", async () => {
		// Warm reads, cascade neighbours and the workspace sweep all land here.
		state.saveOptions = { includeText: false };
		await handleNotifyOpen(
			state,
			TEST_FILE,
			"const x = 1;\n",
			"typescript",
			false,
			true,
		);
		expect(sentMethods(state)).toEqual(["textDocument/didOpen"]);
	});

	it("sends no didSave for content whose own notification never left the process", async () => {
		// safeSendNotification swallows a destroyed stream and returns false; a
		// save claimed then would tell the server to diagnose bytes it never got.
		state.saveOptions = { includeText: false };
		const streamError = Object.assign(new Error("write after end"), {
			code: "ERR_STREAM_WRITE_AFTER_END",
		});
		vi.mocked(state.connection.sendNotification).mockRejectedValueOnce(
			streamError,
		);
		await handleNotifyOpen(
			state,
			TEST_FILE,
			"const x = 1;\n",
			"typescript",
			false,
			true,
			true,
		);
		expect(sentMethods(state)).toEqual(["textDocument/didOpen"]);
	});

	it("keeps the save when an unsaved notify coalesces over a saved one", async () => {
		// The pipeline's post-write touch and the dispatch runner's read touch
		// land on the same path within one turn. The runner's entry replaces the
		// pipeline's before it starts writing whenever the pipeline's write has
		// not landed yet — so the save intent has to survive the replacement, and
		// describe the newer bytes.
		state.saveOptions = { includeText: true };
		const saved = handleNotifyOpen(
			state,
			TEST_FILE,
			"const x = 1;\n",
			"typescript",
			false,
			true,
			true,
		);
		const superseding = handleNotifyOpen(
			state,
			TEST_FILE,
			"const x = 2;\n",
			"typescript",
			false,
			true,
			false,
		);
		await Promise.all([saved, superseding]);
		expect(sentMethods(state)).toEqual([
			"textDocument/didOpen",
			"textDocument/didSave",
		]);
		expect(sentParams(state, "textDocument/didSave")).toEqual({
			textDocument: { uri: TEST_URI },
			text: "const x = 2;\n",
		});
	});

	it("sends no didSave when the client dies between the two notifications", async () => {
		// The one window the caller's own entry guard cannot cover: the client is
		// alive when the notify starts and destroyed by the time the content
		// notification has been awaited. A send on a disposed connection throws a
		// non-stream error, which `safeSendNotification` re-raises out of the
		// notify queue — so the save re-checks liveness the same way the
		// reopen-on-resync branch above it does.
		state.saveOptions = { includeText: false };
		vi.mocked(state.connection.sendNotification).mockImplementation(
			async () => {
				state.isDestroyed = true;
				return undefined;
			},
		);
		await handleNotifyOpen(
			state,
			TEST_FILE,
			"const x = 1;\n",
			"typescript",
			false,
			true,
			true,
		);
		expect(sentMethods(state)).toEqual(["textDocument/didOpen"]);
	});
});

/**
 * Records every notification the fake server reports receiving, and hands back
 * a promise that settles when a named one arrives — a deterministic wait on the
 * event itself, not a polled `vi.waitFor` (flake-shape `ungoverned-wait-for`).
 */
function notifyRecorder(client: Awaited<ReturnType<typeof createLSPClient>>) {
	const methods: string[] = [];
	const saves: Array<{ uri: string; hasText: boolean }> = [];
	const waiters = new Map<string, () => void>();
	let saveWaiter: (() => void) | undefined;
	client.connection.onNotification("$/test/notifyReceived", ((params: {
		method: string;
	}) => {
		methods.push(params.method);
		waiters.get(params.method)?.();
		waiters.delete(params.method);
	}) as never);
	client.connection.onNotification("$/test/didSaveReceived", ((params: {
		uri: string;
		hasText: boolean;
	}) => {
		saves.push(params);
		saveWaiter?.();
		saveWaiter = undefined;
	}) as never);
	return {
		methods,
		saves,
		until(method: string): Promise<void> {
			if (methods.includes(method)) return Promise.resolve();
			return new Promise<void>((resolve) => waiters.set(method, resolve));
		},
		/** The echo the fixture sends from its didSave branch, which lands AFTER
		 *  the generic method echo — so the save's own params need their own
		 *  event to wait on. */
		untilSave(): Promise<void> {
			if (saves.length > 0) return Promise.resolve();
			return new Promise<void>((resolve) => {
				saveWaiter = resolve;
			});
		},
	};
}

describe("didSave through the real createLSPClient init path (#3405)", () => {
	it("a server advertising save: true receives didSave after didOpen", async () => {
		const proc = await spawnFakeLspServer({
			cwd: process.cwd(),
			env: {
				...process.env,
				FAKE_LSP_SAVE: "true",
				FAKE_LSP_ECHO_DID_SAVE: "1",
				FAKE_LSP_ECHO_NOTIFY_METHODS: "1",
			},
		});
		const client = await createLSPClient({
			serverId: "fake-save",
			process: proc,
			root: process.cwd(),
		});
		try {
			const recorder = notifyRecorder(client);
			const filePath = path.join(os.tmpdir(), "pi-lens-did-save-real.ts");
			await client.notify.open(
				filePath,
				"const x = 1;\n",
				"typescript",
				undefined,
				true,
				true,
			);
			await recorder.untilSave();
			// #3407: the inventory reads the same negotiated value.
			expect(client.getSaveOptions?.()).toEqual({ includeText: false });

			// The real `initialize` reply drove the send: the fixture advertises
			// `save: true` and nothing else about saving, so no text rides along.
			expect(recorder.saves[0]?.uri).toBe(pathToFileURL(filePath).href);
			expect(recorder.saves[0]?.hasText).toBe(false);
			expect(recorder.methods.indexOf("textDocument/didSave")).toBeGreaterThan(
				recorder.methods.indexOf("textDocument/didOpen"),
			);
		} finally {
			await client.shutdown().catch(() => {});
			await stopLSP(proc).catch(() => {});
		}
	}, 15_000);

	it("a server advertising no save receives no didSave at all", async () => {
		const proc = await spawnFakeLspServer({
			cwd: process.cwd(),
			env: {
				...process.env,
				FAKE_LSP_ECHO_DID_SAVE: "1",
				FAKE_LSP_ECHO_NOTIFY_METHODS: "1",
			},
		});
		const client = await createLSPClient({
			serverId: "fake-no-save",
			process: proc,
			root: process.cwd(),
		});
		try {
			const recorder = notifyRecorder(client);
			const filePath = path.join(os.tmpdir(), "pi-lens-did-save-none.ts");
			await client.notify.open(
				filePath,
				"const x = 1;\n",
				"typescript",
				undefined,
				true,
				true,
			);
			await recorder.until("textDocument/didOpen");
			// #3407: declared no save → the inventory reports none.
			expect(client.getSaveOptions?.()).toBeUndefined();
			// A stdio JSON-RPC stream is FIFO, so a reply to a request issued AFTER
			// the notify proves the server has already drained everything the notify
			// wrote. That is what makes the absence below evidence and not a race —
			// and it is a settled round trip, not a polled wait.
			await client.pingLiveness?.(5000);

			expect(recorder.methods).toContain("textDocument/didOpen");
			expect(recorder.methods).not.toContain("textDocument/didSave");
			expect(recorder.saves).toEqual([]);
		} finally {
			await client.shutdown().catch(() => {});
			await stopLSP(proc).catch(() => {});
		}
	}, 15_000);
});
