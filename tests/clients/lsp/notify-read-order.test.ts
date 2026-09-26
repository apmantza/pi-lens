/**
 * #3481: the per-path notify queue sends the latest READ of a file, not the
 * latest enqueued touch.
 *
 * Recurrence this file prevents: the cascade reads a neighbour, awaits, and
 * only then touches it. When the agent wrote the neighbour in between, the
 * cascade's older bytes queued behind the write's own touch and were sent
 * last. For an equal-length edit the drift sweep could not see it (same size,
 * and the stale touch stamped its record after the write's mtime), so the
 * server kept the old content. Two same-turn pipelines for one file raced the
 * same way.
 *
 * Production chain: the REAL `LSPService.touchFile` -> the REAL
 * `handleNotifyOpen` / `enqueueDocumentNotify` -> a mock `MessageConnection`
 * (the process boundary). Only the server registry and client construction are
 * doubled. `readStamp` values are explicit numbers: the order is what matters.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as clientModule from "../../../clients/lsp/client.js";
import { fingerprintDocumentContent } from "../../../clients/lsp/document-drift.js";
import { LSPService } from "../../../clients/lsp/index.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import {
	gatedPromise,
	type GatedPromise,
} from "../../support/fault-injection.js";
import { waitFor } from "../interleaving-kit.js";
import { createMockState } from "./mock-client-state.js";

const { getServersForFileWithConfig, createLSPClient, logLatency } = vi.hoisted(
	() => ({
		getServersForFileWithConfig: vi.fn(),
		createLSPClient: vi.fn(),
		logLatency: vi.fn(),
	}),
);

vi.mock("../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency,
}));

vi.mock("../../../clients/lsp/config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/config.js")>()),
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../../clients/lsp/client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/client.js")>()),
	createLSPClient,
}));

const ROOT = "/repo";
const FILE = "/repo/neighbour.ts";
const KEY = normalizeMapKey(FILE);
// Equal length on purpose: the drift sweep's size key cannot heal these.
const A = "export const n = 1;\n";
const B = "export const n = 2;\n";
const C = "export const n = 3;\n";
const P = "export const n = 0;\n";

async function setup() {
	const state = createMockState({ root: ROOT, serverId: "typescript" });
	const gates = new Map<string, GatedPromise<void>>();
	const wire: string[] = [];
	vi.mocked(state.connection.sendNotification).mockImplementation(
		async (method: unknown, params: unknown) => {
			const m = String(method).replace("textDocument/", "");
			const p = params as {
				textDocument?: { text?: string };
				contentChanges?: Array<{ text: string }>;
			};
			const text = p?.textDocument?.text ?? p?.contentChanges?.at(-1)?.text;
			if (m === "didSave") {
				wire.push("didSave");
				return;
			}
			if (m !== "didOpen" && m !== "didChange") return;
			wire.push(`${m}:${text}`);
			const gate = text === undefined ? undefined : gates.get(text);
			if (gate) await gate.promise;
		},
	);
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
				readStamp?: number,
			) =>
				clientModule.handleNotifyOpen(
					state,
					filePath,
					content,
					languageId,
					preserveDiagnostics,
					silent,
					saved,
					readStamp,
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
	const touch = (content: string, readStamp?: number, saved = false) =>
		service.touchFile(FILE, content, {
			diagnostics: "none",
			source: "test",
			readStamp,
			...(saved && { saved }),
		});
	// Open the document with A, then step past the 1500 ms touch debounce so a
	// later touch of A is not skipped as a repeat.
	await touch(A);
	vi.setSystemTime(Date.now() + 5_000);
	/** Resolves once `n` touches wait on the unstarted queue entry. */
	const pendingQueued = (n = 1) =>
		waitFor(
			() => state.notifyChangeQueues.get(KEY)?.pending?.waiters.length ?? 0,
			(waiting) => waiting === n,
		);
	const recordFp = () =>
		(
			service as unknown as {
				documentDrift: { peek(p: string): { fingerprint: string } | undefined };
			}
		).documentDrift.peek(FILE)?.fingerprint;
	return { state, wire, gates, touch, pendingQueued, recordFp };
}

describe("#3481 — the notify queue sends the latest read, not the latest enqueued", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("drops a cascade touch read before a newer write's touch that is in flight", async () => {
		const { wire, gates, touch, pendingQueued, recordFp } = await setup();
		const gate = gatedPromise<void>();
		gates.set(B, gate);
		// The cascade read A (stamp 1); the agent then wrote B, and B's pipeline
		// read it (stamp 2) and touched first.
		const pipeline = touch(B, 2);
		await waitFor(
			() => wire.length,
			(n) => n === 2,
		);
		const cascade = touch(A, 1);
		await pendingQueued();
		gate.resolve();
		await Promise.all([pipeline, cascade]);

		expect(wire).toEqual([`didOpen:${A}`, `didChange:${B}`]);
		// The superseded touch claims nothing: the drift record describes what
		// the server holds.
		expect(recordFp()).toBe(fingerprintDocumentContent(B));
	});

	// Round 1 S2: a superseded touch says so in its own lsp_touch_file row.
	it("names the superseded server on the dropped touch's lsp_touch_file row", async () => {
		const { wire, gates, touch, pendingQueued } = await setup();
		const gate = gatedPromise<void>();
		gates.set(B, gate);
		logLatency.mockClear();
		const pipeline = touch(B, 2);
		await waitFor(
			() => wire.length,
			(n) => n === 2,
		);
		const cascade = touch(A, 1);
		await pendingQueued();
		gate.resolve();
		await Promise.all([pipeline, cascade]);

		const rows = logLatency.mock.calls
			.map(
				([entry]) =>
					entry as {
						phase?: string;
						metadata?: { supersededServerIds?: string[] };
					},
			)
			.filter((entry) => entry.phase === "lsp_touch_file")
			.map((entry) => entry.metadata?.supersededServerIds);
		expect(rows).toEqual([undefined, ["typescript"]]);
	});

	// Round 1 B1 (#3405): dropping an older read must not drop the save it
	// carried. The server already holds newer bytes, so the save goes out for
	// the held document (text is optional in DidSaveTextDocumentParams).
	it("still sends didSave when the dropped older read was the save", async () => {
		const { state, wire, touch } = await setup();
		state.saveOptions = { includeText: false };
		await touch(B, 100);
		vi.setSystemTime(Date.now() + 5_000);
		await touch(B, 90, true);

		expect(wire).toEqual([`didOpen:${A}`, `didChange:${B}`, "didSave"]);
	});

	// Round 1 B2: an unstamped touch replacing a pending stamped one keeps the
	// pending stamp, so an older read arriving next is still kept out.
	it("keeps the pending read stamp when an unstamped touch replaces the entry", async () => {
		const { wire, gates, touch, pendingQueued } = await setup();
		await touch(C, 50);
		vi.setSystemTime(Date.now() + 5_000);
		const gate = gatedPromise<void>();
		gates.set(P, gate);
		const earlier = touch(P);
		await waitFor(
			() => wire.length,
			(n) => n === 3,
		);
		const newer = touch(B, 100);
		await pendingQueued();
		const unstamped = touch(A);
		await pendingQueued(2);
		const stale = touch(C, 70);
		await pendingQueued(3);
		gate.resolve();
		await Promise.all([earlier, newer, unstamped, stale]);

		expect(wire).toEqual([
			`didOpen:${A}`,
			`didChange:${C}`,
			`didChange:${P}`,
			`didChange:${A}`,
		]);
	});

	it("drops a touch read before content already sent after its queue retired", async () => {
		const { wire, touch } = await setup();
		// Two same-turn pipelines: #1 read B (stamp 1), the agent wrote C, #2 read
		// C (stamp 2) and finished its whole touch before #1 reached the queue.
		await touch(C, 2);
		await touch(B, 1);

		expect(wire).toEqual([`didOpen:${A}`, `didChange:${C}`]);
	});

	it("keeps a pending newer read when an older read arrives behind an in-flight send", async () => {
		const { wire, gates, touch, pendingQueued, recordFp } = await setup();
		const gate = gatedPromise<void>();
		gates.set(P, gate);
		const earlier = touch(P);
		await waitFor(
			() => wire.length,
			(n) => n === 2,
		);
		const newer = touch(B, 2);
		await pendingQueued();
		const stale = touch(A, 1);
		await pendingQueued(2);
		gate.resolve();
		await Promise.all([earlier, newer, stale]);

		expect(wire).toEqual([`didOpen:${A}`, `didChange:${P}`, `didChange:${B}`]);
		// The kept-out caller resolves after B's and must not stamp A over it.
		expect(recordFp()).toBe(fingerprintDocumentContent(B));
	});

	it("still replaces a pending older read with a newer one", async () => {
		const { wire, gates, touch, pendingQueued } = await setup();
		const gate = gatedPromise<void>();
		gates.set(P, gate);
		const earlier = touch(P);
		await waitFor(
			() => wire.length,
			(n) => n === 2,
		);
		const older = touch(B, 1);
		await pendingQueued();
		const newer = touch(C, 2);
		await pendingQueued(2);
		gate.resolve();
		await Promise.all([earlier, older, newer]);

		expect(wire).toEqual([`didOpen:${A}`, `didChange:${P}`, `didChange:${C}`]);
	});

	it("still drops a read older than the last stamp after an unstamped send", async () => {
		const { wire, touch } = await setup();
		await touch(B, 2);
		// An unstamped touch (a warm-up, an explicit query) cannot say how old
		// its bytes are, so it leaves the last stamp in place.
		vi.setSystemTime(Date.now() + 5_000);
		await touch(C);
		await touch(A, 1);

		expect(wire).toEqual([`didOpen:${A}`, `didChange:${B}`, `didChange:${C}`]);
	});

	it("sends ordinary edits in read order one after another", async () => {
		const { wire, touch } = await setup();
		await touch(B, 1);
		vi.setSystemTime(Date.now() + 5_000);
		await touch(C, 2);

		expect(wire).toEqual([`didOpen:${A}`, `didChange:${B}`, `didChange:${C}`]);
	});

	it("sends a revert to the superseded content inside the debounce window", async () => {
		const { wire, gates, touch, pendingQueued } = await setup();
		const gate = gatedPromise<void>();
		gates.set(B, gate);
		const pipeline = touch(B, 2);
		await waitFor(
			() => wire.length,
			(n) => n === 2,
		);
		const cascade = touch(A, 1);
		await pendingQueued();
		gate.resolve();
		await Promise.all([pipeline, cascade]);
		// The agent reverts the file to A right away. The server holds B, so the
		// debounce must not treat A as already pushed.
		await touch(A, 3);

		expect(wire).toEqual([`didOpen:${A}`, `didChange:${B}`, `didChange:${A}`]);
	});
});
