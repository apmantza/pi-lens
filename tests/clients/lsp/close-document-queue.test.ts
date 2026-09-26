/**
 * #3477: rename's `closeDocument` runs on the per-path notify queue.
 *
 * Recurrence this file prevents: `closeDocument` sent `didClose` beside the
 * queue that serializes `didOpen`/`didChange`, and dropped the path from
 * `openDocuments` only after its own send resolved. A change queued behind an
 * in-flight one then sent `didChange` after `didClose` (trace A); a change
 * queued before the rename re-opened the renamed-away path (trace C); and a
 * rename that started while the path's open was in flight closed nothing,
 * because `isDocumentOpen` was still false (trace B).
 *
 * Production chain: the REAL client functions over `createMockState`, the
 * JSON-RPC connection is the only double; trace B goes through the REAL
 * `LSPService.renameFile` with a client wired to that same state.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	closeDocument,
	handleNotifyChange,
	handleNotifyOpen,
	type LSPClientState,
} from "../../../clients/lsp/client.js";
import { LSPService } from "../../../clients/lsp/index.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import {
	gatedPromise,
	type GatedPromise,
} from "../../support/fault-injection.js";
import { waitFor } from "../interleaving-kit.js";
import { removeTempDirSync } from "../test-utils.js";
import { createMockState } from "./mock-client-state.js";

let tmpDir: string;
let FILE: string;
let KEY: string;

/** Record each lifecycle message in wire order; hold the ones gated. */
function recordWire(
	state: LSPClientState,
	gates: Partial<Record<string, GatedPromise<void>>> = {},
) {
	const order: string[] = [];
	vi.mocked(state.connection.sendNotification).mockImplementation(
		async (method: unknown) => {
			const m = String(method).replace("textDocument/", "");
			if (!["didOpen", "didChange", "didClose"].includes(m)) return;
			order.push(m);
			const gate = gates[m];
			if (gate) await gate.promise;
		},
	);
	return order;
}

function openState(): LSPClientState {
	const state = createMockState({ root: tmpDir });
	state.openDocuments.add(KEY);
	state.documentVersions.set(KEY, 1);
	return state;
}

describe("#3477 — closeDocument is ordered with the path's notify queue", () => {
	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-close-queue-"));
		FILE = path.join(tmpDir, "old.ts");
		KEY = normalizeMapKey(FILE);
		fs.writeFileSync(FILE, "export const v = 0;\n");
	});
	afterEach(() => {
		removeTempDirSync(tmpDir);
		vi.restoreAllMocks();
	});

	it("never sends didChange after didClose when a change was queued behind one in flight (trace A)", async () => {
		const state = openState();
		const change = gatedPromise<void>();
		const close = gatedPromise<void>();
		const order = recordWire(state, { didChange: change, didClose: close });

		const first = handleNotifyChange(state, FILE, "v1"); // in flight
		await waitFor(
			() => order.length,
			(n) => n === 1,
		);
		const second = handleNotifyChange(state, FILE, "v2"); // queued
		const closing = closeDocument(state, FILE); // rename's close
		change.resolve();
		await first;
		close.resolve();
		await Promise.all([second, closing]);

		expect(order).toEqual(["didChange", "didClose"]);
		expect(state.openDocuments.has(KEY)).toBe(false);
	});

	it("does not re-open the renamed-away path from a change queued before the rename (trace C)", async () => {
		const state = openState();
		const change = gatedPromise<void>();
		const order = recordWire(state, { didChange: change });

		const first = handleNotifyChange(state, FILE, "v1");
		await waitFor(
			() => order.length,
			(n) => n === 1,
		);
		const second = handleNotifyChange(state, FILE, "v2");
		const closing = closeDocument(state, FILE);
		change.resolve();
		await Promise.all([first, second, closing]);
		// The rename moves the file after the close.
		fs.renameSync(FILE, path.join(tmpDir, "new.ts"));

		expect(order).toEqual(["didChange", "didClose"]);
		expect(state.openDocuments.has(KEY)).toBe(false);
	});

	it("does not re-open the path from a touch (didOpen entry) queued before the rename", async () => {
		const state = openState();
		const change = gatedPromise<void>();
		const order = recordWire(state, { didChange: change });

		const first = handleNotifyOpen(state, FILE, "v1", "typescript");
		await waitFor(
			() => order.length,
			(n) => n === 1,
		);
		const second = handleNotifyOpen(state, FILE, "v2", "typescript");
		const closing = closeDocument(state, FILE);
		change.resolve();

		await expect(second).resolves.toBe(false);
		await Promise.all([first, closing]);
		expect(order).toEqual(["didChange", "didClose"]);
		expect(state.openDocuments.has(KEY)).toBe(false);
	});

	it("drops a touch that arrives while the close is queued, and still closes", async () => {
		const state = openState();
		const change = gatedPromise<void>();
		const order = recordWire(state, { didChange: change });

		const first = handleNotifyOpen(state, FILE, "v1", "typescript");
		await waitFor(
			() => order.length,
			(n) => n === 1,
		);
		const closing = closeDocument(state, FILE);
		const late = handleNotifyOpen(state, FILE, "v2", "typescript");
		change.resolve();

		await expect(late).resolves.toBe(false);
		await Promise.all([first, closing]);
		expect(order).toEqual(["didChange", "didClose"]);
	});

	it("drops a touch of a closed path whose file is gone", async () => {
		const state = openState();
		const order = recordWire(state);
		await closeDocument(state, FILE);
		fs.renameSync(FILE, path.join(tmpDir, "new.ts"));

		// A carried-over cascade touch read the old file before the rename.
		await expect(
			handleNotifyOpen(state, FILE, "v0", "typescript"),
		).resolves.toBe(false);

		expect(order).toEqual(["didClose"]);
		expect(state.openDocuments.has(KEY)).toBe(false);
	});

	it("drops a late change of a closed path whose file is gone instead of its fallback didOpen", async () => {
		const state = openState();
		const order = recordWire(state);
		await closeDocument(state, FILE);
		fs.renameSync(FILE, path.join(tmpDir, "new.ts"));

		await expect(handleNotifyChange(state, FILE, "v0")).resolves.toBe(false);

		expect(order).toEqual(["didClose"]);
		expect(state.openDocuments.has(KEY)).toBe(false);
	});

	it("drops a late touch of a renamed-away path this client never had open", async () => {
		const state = createMockState({ root: tmpDir });
		const order = recordWire(state);
		await closeDocument(state, FILE);
		fs.renameSync(FILE, path.join(tmpDir, "new.ts"));

		await expect(
			handleNotifyOpen(state, FILE, "v0", "typescript"),
		).resolves.toBe(false);

		expect(order).toEqual([]);
		expect(state.openDocuments.has(KEY)).toBe(false);
	});

	it("re-opens a closed path when a file exists there again", async () => {
		const state = openState();
		const order = recordWire(state);
		await closeDocument(state, FILE);

		// Renamed back, or a new file created at the old path.
		await expect(
			handleNotifyOpen(state, FILE, "v9", "typescript"),
		).resolves.toBe(true);

		expect(order).toEqual(["didClose", "didOpen"]);
		expect(state.openDocuments.has(KEY)).toBe(true);
	});

	// Verify round F1: an unstamped close used to inherit the stamp of the touch
	// it superseded; when that touch was a stale read, the runner dropped the
	// whole entry and no didClose was sent while the rename still went ahead.
	it("still closes when the close supersedes a stale stamped touch queued behind an in-flight send", async () => {
		const state = openState();
		const change = gatedPromise<void>();
		const order = recordWire(state, { didChange: change });

		const first = handleNotifyOpen(
			state,
			FILE,
			"v10",
			"typescript",
			false,
			false,
			false,
			10,
		);
		await waitFor(
			() => order.length,
			(n) => n === 1,
		);
		const stale = handleNotifyOpen(
			state,
			FILE,
			"v5",
			"typescript",
			false,
			false,
			false,
			5,
		);
		const closing = closeDocument(state, FILE);
		change.resolve();
		await Promise.all([first, stale, closing]);

		expect(order).toEqual(["didChange", "didClose"]);
		expect(state.openDocuments.has(KEY)).toBe(false);
	});

	it("still closes when a stale stamped touch and the close arrive in one tick after the newer send", async () => {
		const state = openState();
		const order = recordWire(state);

		await handleNotifyOpen(
			state,
			FILE,
			"v10",
			"typescript",
			false,
			false,
			false,
			10,
		);
		const stale = handleNotifyOpen(
			state,
			FILE,
			"v5",
			"typescript",
			false,
			false,
			false,
			5,
		);
		const closing = closeDocument(state, FILE);
		await Promise.all([stale, closing]);

		expect(order).toEqual(["didChange", "didClose"]);
		expect(state.openDocuments.has(KEY)).toBe(false);
	});

	it("closes at once when nothing is in flight, and sends nothing for a path that is not open", async () => {
		const open = openState();
		const openOrder = recordWire(open);
		await closeDocument(open, FILE);
		expect(openOrder).toEqual(["didClose"]);

		const idle = createMockState({ root: tmpDir });
		const idleOrder = recordWire(idle);
		await closeDocument(idle, FILE);
		expect(idleOrder).toEqual([]);
	});
});

describe("#3477 — renameFile closes a document whose open is in flight (trace B)", () => {
	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-close-queue-"));
		FILE = path.join(tmpDir, "old.ts");
		KEY = normalizeMapKey(FILE);
		fs.writeFileSync(FILE, "export const v = 0;\n");
	});
	afterEach(() => {
		removeTempDirSync(tmpDir);
		vi.restoreAllMocks();
	});

	it("leaves the old path closed after a rename that raced its didOpen", async () => {
		const clientModule = await import("../../../clients/lsp/client.js");
		const state = createMockState({ root: tmpDir });
		const open = gatedPromise<void>();
		const order = recordWire(state, { didOpen: open });
		const client = {
			root: tmpDir,
			isAlive: () => true,
			isDocumentOpen: (p: string) =>
				state.openDocuments.has(normalizeMapKey(p)),
			getDocumentUri: () => undefined,
			closeDocument: (p: string) => clientModule.closeDocument(state, p),
			notify: {
				open: (p: string, content: string, languageId: string) =>
					clientModule.handleNotifyOpen(state, p, content, languageId),
			},
			willRenameFiles: async () => null,
			getOperationSupport: () => ({
				willRenameFiles: false,
				didRenameFiles: false,
			}),
			getMalformedFileOperationRegistrations: () => new Set(),
			didRenameFiles: async () => {},
		};
		const service = new LSPService();
		(
			service as unknown as { state: { clients: Map<string, unknown> } }
		).state.clients.set(`typescript:${normalizeMapKey(tmpDir)}`, client);

		const opening = client.notify.open(
			FILE,
			"export const v = 0;\n",
			"typescript",
		);
		await waitFor(
			() => order.length,
			(n) => n === 1,
		);
		let renameSettled = false;
		const renaming = service
			.renameFile(FILE, path.join(tmpDir, "new.ts"), {
				cwd: tmpDir,
				apply: true,
			})
			.finally(() => {
				renameSettled = true;
			});
		// The open lands only once the rename has decided what to close: either
		// it queued a close behind the open, or it finished without one.
		await waitFor(
			() =>
				renameSettled ||
				state.notifyChangeQueues.get(KEY)?.pending !== undefined,
			(decided) => decided,
		);
		open.resolve();
		await Promise.all([opening, renaming]);

		expect(order).toEqual(["didOpen", "didClose"]);
		expect(state.openDocuments.has(KEY)).toBe(false);
	});
});
