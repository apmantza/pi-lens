/**
 * #5700: which document the open-document cap closes, and which it must not.
 *
 * Recurrences this file prevents (each guard in `enforceOpenDocumentCap`):
 * - recency: a document the agent keeps editing is sent as `didChange`, never
 *   re-opened, so without `noteDocumentSent` it stays at the head of the send
 *   order and the cap closes the file being worked on instead of a cold one.
 * - live queue: the cap's close is an ordinary entry on the path's notify
 *   queue, and a newer entry replaces an unsent one. Issued while an edit
 *   waits behind a send in flight, the close replaces that edit: its bytes
 *   never reach the server, and its caller is told they were sent.
 *   `formal/lsp-document-lifecycle` `MutBudgetCloseNoSkip` is the same
 *   defect in the model.
 * - failed close: the close runs detached; a rejected didClose must leave a
 *   record and the document open, not an unhandled rejection.
 * - settling publish: a publish still in its debounce window answers the
 *   bytes last sent. Closing the document then drops that answer, so the
 *   cache keeps the older finding and the wait on it never confirms.
 *
 * Production chain: the REAL client functions over `createMockState`; the
 * JSON-RPC connection is the only double, as in `close-document-queue.test.ts`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	handleNotifyChange,
	handleNotifyOpen,
	type LSPClientState,
	type LSPDiagnostic,
	setupIncomingHandlers,
} from "../../../clients/lsp/client.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import {
	gatedPromise,
	type GatedPromise,
} from "../../support/fault-injection.js";
import { waitFor } from "../interleaving-kit.js";
import { removeTempDirSync } from "../test-utils.js";
import { createMockState } from "./mock-client-state.js";

let tmpDir: string;
const file = (name: string) => path.join(tmpDir, name);
const key = (name: string) => normalizeMapKey(file(name));

const D: LSPDiagnostic = {
	severity: 1,
	message: "unused import",
	range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
};

/** Record each lifecycle message as `<method> <file name>`; hold the ones gated. */
function recordWire(
	state: LSPClientState,
	gates: Partial<Record<string, GatedPromise<void>>> = {},
) {
	const order: string[] = [];
	vi.mocked(state.connection.sendNotification).mockImplementation(
		async (method: unknown, params: unknown) => {
			const m = String(method).replace("textDocument/", "");
			if (!["didOpen", "didChange", "didClose"].includes(m)) return;
			const uri = (params as { textDocument: { uri: string } }).textDocument
				.uri;
			order.push(`${m} ${path.basename(new URL(uri).pathname)}`);
			const gate = gates[m];
			if (gate) await gate.promise;
		},
	);
	return order;
}

async function open(state: LSPClientState, name: string) {
	expect(
		await handleNotifyOpen(state, file(name), `// ${name}\n`, "typescript"),
	).toBe(true);
}

describe("#5700 open-document cap: the victim", () => {
	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-open-cap-"));
		for (const name of ["a.ts", "b.ts", "c.ts"])
			fs.writeFileSync(file(name), `// ${name}\n`);
	});
	afterEach(() => {
		vi.useRealTimers();
		removeTempDirSync(tmpDir);
		vi.restoreAllMocks();
	});

	it("closes the least recently SENT document, so an edited one stays open", async () => {
		const state = createMockState({ root: tmpDir, openDocumentCap: 2 });
		const order = recordWire(state);
		await open(state, "a.ts");
		await open(state, "b.ts");
		// a.ts was opened first, but this edit makes it the most recent.
		expect(await handleNotifyChange(state, file("a.ts"), "// a2\n")).toBe(true);
		await open(state, "c.ts");
		await waitFor(
			() => state.openDocuments.size,
			(n) => n === 2,
		);

		expect(order).toEqual([
			"didOpen a.ts",
			"didOpen b.ts",
			"didChange a.ts",
			"didOpen c.ts",
			"didClose b.ts",
		]);
		expect([...state.openDocuments]).toEqual([key("a.ts"), key("c.ts")]);
	});

	// Recurrence: a close still in flight leaves its document in
	// `openDocuments`, so an open that lands meanwhile counted it again and
	// closed one document too many.
	it("counts a close still in flight, so a burst of opens closes no more than the excess", async () => {
		fs.writeFileSync(file("d.ts"), "// d.ts\n");
		const state = createMockState({ root: tmpDir, openDocumentCap: 2 });
		const close = gatedPromise<void>();
		const order = recordWire(state, { didClose: close });
		await open(state, "a.ts");
		await open(state, "b.ts");
		await open(state, "c.ts"); // queues the close of a.ts, held in flight
		await waitFor(
			() => order.length,
			(n) => n === 4,
		);
		await open(state, "d.ts");
		close.resolve();
		await waitFor(
			() => state.openDocuments.size,
			(n) => n <= 2,
		);
		await new Promise((resolve) => setImmediate(resolve));

		expect(order).toEqual([
			"didOpen a.ts",
			"didOpen b.ts",
			"didOpen c.ts",
			"didClose a.ts",
			"didOpen d.ts",
			"didClose b.ts",
		]);
		expect([...state.openDocuments]).toEqual([key("c.ts"), key("d.ts")]);
	});

	// Recurrence: the close runs detached, so a rejected didClose became an
	// unhandled rejection, or vanished with no record while the document it
	// meant to close stayed open.
	it("records a didClose that failed and keeps the document open for the next try", async () => {
		const state = createMockState({ root: tmpDir, openDocumentCap: 1 });
		const order = recordWire(state);
		await open(state, "a.ts");
		const send = vi.mocked(state.connection.sendNotification);
		const recorded = send.getMockImplementation();
		send.mockImplementation(async (method: unknown, params: unknown) => {
			if (method === "textDocument/didClose") throw new Error("write EINVAL");
			return recorded?.(method as never, params as never);
		});
		resetDegradationLedger();
		await open(state, "b.ts");
		await waitFor(
			() =>
				getDegradationSummary()
					.filter((group) => group.kind === "lsp-open-document-cap")
					.flatMap((group) => group.latestReasons.map((r) => r.subject)),
			(subjects) => subjects.includes(`${state.serverId}:close-failed`),
		);

		expect(order).toEqual(["didOpen a.ts", "didOpen b.ts"]);
		expect(state.openDocuments.has(key("a.ts"))).toBe(true);
		resetDegradationLedger();
	});

	it("leaves a document alone while an edit waits behind its send in flight", async () => {
		const state = createMockState({ root: tmpDir, openDocumentCap: 1 });
		const change = gatedPromise<void>();
		const order = recordWire(state, { didChange: change });
		await open(state, "a.ts");

		const first = handleNotifyChange(state, file("a.ts"), "// a1\n");
		await waitFor(
			() => order.length,
			(n) => n === 2,
		);
		const second = handleNotifyChange(state, file("a.ts"), "// a2\n");
		// b.ts lands past the cap while a.ts has a send in flight and an edit
		// queued behind it.
		await open(state, "b.ts");
		change.resolve();
		await expect(first).resolves.toBe(true);
		await expect(second).resolves.toBe(true);

		expect(order).toEqual([
			"didOpen a.ts",
			"didChange a.ts",
			"didOpen b.ts",
			"didChange a.ts",
		]);
		expect(state.openDocuments.has(key("a.ts"))).toBe(true);
	});

	it("leaves a document alone while its publish is still settling", async () => {
		const state = createMockState({ root: tmpDir, openDocumentCap: 1 });
		const order = recordWire(state);
		setupIncomingHandlers(state, {});
		type Publish = (params: {
			uri: string;
			version?: number;
			diagnostics: LSPDiagnostic[];
		}) => void;
		const publish = (
			vi.mocked(state.connection.onNotification).mock.calls as unknown as Array<
				[string, Publish]
			>
		).find(([method]) => method === "textDocument/publishDiagnostics")?.[1];
		expect(publish).toBeDefined();
		await open(state, "a.ts");

		vi.useFakeTimers();
		publish!({
			uri: pathToFileURL(file("a.ts")).href,
			version: 0,
			diagnostics: [D],
		});
		expect(state.pendingDiagnostics.has(key("a.ts"))).toBe(true);
		await open(state, "b.ts");
		await vi.advanceTimersByTimeAsync(2_000);

		expect(order).toEqual(["didOpen a.ts", "didOpen b.ts"]);
		expect(state.pushDiagnostics.get(key("a.ts"))).toEqual([D]);
	});

	// Recurrence: a publish arriving while the retained cap close awaits didClose
	// passes the not-yet-set closed-document guard, and its debounce timer can
	// overwrite the findings that the close is required to retain.
	it("cancels a publish timer armed while a retained cap close is in flight", async () => {
		const state = createMockState({
			root: tmpDir,
			openDocumentCap: 1,
			serverId: "typos",
		});
		const close = gatedPromise<void>();
		const order = recordWire(state, { didClose: close });
		setupIncomingHandlers(state, {});
		type Publish = (params: {
			uri: string;
			version?: number;
			diagnostics: LSPDiagnostic[];
		}) => void;
		const publish = (
			vi.mocked(state.connection.onNotification).mock.calls as unknown as Array<
				[string, Publish]
			>
		).find(([method]) => method === "textDocument/publishDiagnostics")?.[1];
		expect(publish).toBeDefined();

		await open(state, "a.ts");
		publish!({
			uri: pathToFileURL(file("a.ts")).href,
			version: 1,
			diagnostics: [D],
		});
		expect(state.pushDiagnostics.get(key("a.ts"))).toEqual([D]);

		vi.useFakeTimers();
		try {
			const late: LSPDiagnostic = { ...D, message: "late publish" };
			await open(state, "b.ts");
			expect(order).toEqual(["didOpen a.ts", "didOpen b.ts", "didClose a.ts"]);
			// The cap close is still awaiting didClose, so closedDocuments is not
			// marked yet and this receipt reaches the real debounce handler.
			publish!({
				uri: pathToFileURL(file("a.ts")).href,
				version: 2,
				diagnostics: [late],
			});
			expect(state.pendingDiagnostics.has(key("a.ts"))).toBe(true);

			close.resolve();
			await vi.advanceTimersByTimeAsync(2_000);
			expect(state.pushDiagnostics.get(key("a.ts"))).toEqual([D]);
		} finally {
			vi.useRealTimers();
		}
	});
});
