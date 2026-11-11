/**
 * #3383 — newline framing has a ceiling, so a peer that never sends a newline
 * cannot grow the reader's buffer without limit.
 *
 * ## The recurrence this guards
 *
 * Every framed reader in the tree was `buffer += chunk` with no bound: the MCP
 * host's stdin loop (`mcp/server.ts`), the warm IPC clients
 * (`requestOverWarmIpc`, `requestWarmAnalyze`) and the shared server-side
 * reader used by `mcp/server.ts` and `clients/warm-attach.ts`. That is the same
 * shape #3375 fixed for child output, one layer out: the concatenation runs
 * inside a `data` handler, where V8's `RangeError: Invalid string length` is an
 * uncaught exception rather than a value any caller can see. Measured before
 * the bound, through `requestWarmAnalyze` against a real unix socket: a 64 MiB
 * newline-free reply grew heap by 929 MiB and ended only when the request's own
 * 20 s timeout fired.
 *
 * The real-socket cases below are the production path (a real
 * `net.createConnection`, a real peer writing real bytes); the unit cases drive
 * the exported reader all five call sites share, because framing state is per
 * reader and the resync cases need chunk boundaries a socket will not
 * reproduce on demand.
 *
 * ROUND 2 (review H3388-1). The first version of the bound checked only the
 * newline-free REMAINDER of a chunk, so an over-limit frame that arrived with
 * its newline in the same `data` chunk — one `socket.write`, one TCP segment —
 * was dispatched whole: measured through this reader at 33,554,433 bytes
 * delivered, 0 overflow callbacks, 0 records. The three chunk-boundary cases
 * and the single-write socket case below are that defect's regression set: the
 * bound belongs to the FRAME, not to whatever a chunk happens to end with.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	boundUnixSocketPath,
	createWarmIpcLineReader,
	ipcPathForCwd,
	MAX_FRAMED_LINE_BYTES,
	requestWarmAnalyze,
} from "../../../clients/mcp/ipc.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";

const MiB = 1024 * 1024;

function overflowRow() {
	return getDegradationSummary().find(
		(entry) => entry.kind === "ipc-frame-overflow",
	);
}

/** One chunk past the bound, in one go — the reader bounds bytes, not chunks. */
function oversizedChunk(): string {
	return "x".repeat(MAX_FRAMED_LINE_BYTES + 1);
}

beforeEach(() => {
	resetDegradationLedger();
});

afterEach(() => {
	resetDegradationLedger();
	vi.restoreAllMocks();
});

describe("createWarmIpcLineReader bound (#3383)", () => {
	it("discards an unterminated line past the bound, records it once, and ends the caller", () => {
		const lines: string[] = [];
		const overflows: number[] = [];
		const read = createWarmIpcLineReader((line) => lines.push(line), {
			label: "warm-analyze-reply",
			onOverflow: () => overflows.push(1),
		});
		read(oversizedChunk());
		expect(lines).toEqual([]);
		expect(overflows).toEqual([1]);
		const row = overflowRow();
		expect(row?.count).toBe(1);
		expect(row?.latestReasons[0]?.subject).toBe("warm-analyze-reply");
		expect(row?.latestReasons[0]?.reason).toContain(
			`limit ${MAX_FRAMED_LINE_BYTES}`,
		);
		expect(row?.latestReasons[0]?.reason).toContain(
			"discarded an unterminated line",
		);
		// Latched: the peer's remaining bytes reach nothing.
		read('{"result":{}}\n');
		expect(lines).toEqual([]);
	});

	it("discards an over-limit frame delivered whole, newline and all, in one chunk", () => {
		// H3388-1's exact input: the reviewer's probe as a test.
		const lines: string[] = [];
		const overflows: number[] = [];
		const read = createWarmIpcLineReader((line) => lines.push(line), {
			label: "warm-analyze-reply",
			onOverflow: () => overflows.push(1),
		});
		read(`${"x".repeat(MAX_FRAMED_LINE_BYTES + 1)}\n`);
		expect(lines).toEqual([]);
		expect(overflows).toEqual([1]);
		const row = overflowRow();
		expect(row?.count).toBe(1);
		expect(row?.latestReasons[0]?.reason).toContain(
			"discarded a complete line",
		);
		expect(row?.latestReasons[0]?.reason).toContain(
			`${MAX_FRAMED_LINE_BYTES + 1} bytes`,
		);
	});

	it("discards an over-limit frame whose newline arrives in a later chunk", () => {
		const lines: string[] = [];
		const overflows: number[] = [];
		const read = createWarmIpcLineReader((line) => lines.push(line), {
			label: "warm-analyze-reply",
			onOverflow: () => overflows.push(1),
		});
		// Exactly at the limit and still unterminated: the remainder check must
		// NOT fire, so only the per-frame check can catch what comes next.
		read("x".repeat(MAX_FRAMED_LINE_BYTES));
		expect(overflows).toEqual([]);
		read("x\n");
		expect(lines).toEqual([]);
		expect(overflows).toEqual([1]);
		expect(overflowRow()?.count).toBe(1);
	});

	it("delivers a frame exactly at the limit", () => {
		const lines: string[] = [];
		const read = createWarmIpcLineReader((line) => lines.push(line), {
			label: "warm-analyze-reply",
			onOverflow: () => lines.push("OVERFLOW"),
		});
		read(`${"x".repeat(MAX_FRAMED_LINE_BYTES)}\n`);
		expect(lines).toHaveLength(1);
		expect(Buffer.byteLength(lines[0])).toBe(MAX_FRAMED_LINE_BYTES);
		expect(overflowRow()).toBeUndefined();
	});

	it("keeps framing the request BEHIND a discarded complete frame", () => {
		// A complete over-limit line is already past its own newline, so framing
		// must continue there. Resyncing instead would eat this next request.
		const lines: string[] = [];
		const read = createWarmIpcLineReader((line) => lines.push(line), {
			label: "mcp-stdio",
			continuous: true,
		});
		read(`${"x".repeat(MAX_FRAMED_LINE_BYTES + 1)}\n{"method":"initialize"}\n`);
		expect(lines).toEqual(['{"method":"initialize"}']);
		// And in the NEXT chunk, which is where a wrong resync actually bites:
		// the handler only consults `resyncing` at the top of a chunk, so a
		// complete frame marked "awaiting a newline" swallows the request behind
		// it one chunk later.
		read('{"method":"tools/list"}\n');
		expect(lines).toEqual([
			'{"method":"initialize"}',
			'{"method":"tools/list"}',
		]);
		expect(overflowRow()?.count).toBe(1);
	});

	it("delivers a framed line that fits, so the bound is not a blanket refusal", () => {
		const lines: string[] = [];
		const read = createWarmIpcLineReader((line) => lines.push(line), {
			label: "warm-analyze-reply",
			onOverflow: () => lines.push("OVERFLOW"),
		});
		read('{"result":');
		read('{"ok":true}}\n');
		expect(lines).toEqual(['{"result":{"ok":true}}']);
		expect(overflowRow()).toBeUndefined();
	});

	it("resyncs at the discarded line's newline so the next request still parses", () => {
		const lines: string[] = [];
		const read = createWarmIpcLineReader((line) => lines.push(line), {
			label: "mcp-stdio",
			continuous: true,
		});
		read(oversizedChunk());
		// The rest of the over-long line, then a well-formed request behind it.
		read(`yyy\n{"method":"initialize"}\n`);
		expect(lines).toEqual(['{"method":"initialize"}']);
		expect(overflowRow()?.count).toBe(1);
	});

	it("keeps framing after each line when continuous, and stops after one when not", () => {
		const many: string[] = [];
		const readMany = createWarmIpcLineReader((line) => many.push(line), {
			label: "mcp-stdio",
			continuous: true,
		});
		readMany('{"id":1}\n{"id":2}\n');
		readMany('{"id":3}\n');
		expect(many).toEqual(['{"id":1}', '{"id":2}', '{"id":3}']);

		const once: string[] = [];
		const readOnce = createWarmIpcLineReader((line) => once.push(line), {
			label: "mcp-warm-server",
		});
		readOnce('{"id":1}\n{"id":2}\n');
		expect(once).toEqual(['{"id":1}']);
	});
});

describe("requestWarmAnalyze against an unframed peer (#3383)", () => {
	const sockets: net.Server[] = [];
	const cwd = `/pi-lens-3383/${process.pid}`;

	afterEach(async () => {
		for (const server of sockets.splice(0)) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		try {
			fs.unlinkSync(ipcPathForCwd(cwd));
		} catch {
			// no socket file on Windows, and an already-removed one is fine
		}
	});

	it("discards a single-write over-limit framed reply", async () => {
		// H3388-1 through the production client over a real socket: ONE write
		// carrying the whole over-limit frame, newline included.
		const endpoint = ipcPathForCwd(cwd);
		try {
			fs.unlinkSync(endpoint);
		} catch {
			// no stale socket
		}
		let peer: net.Socket | undefined;
		const server = net.createServer((socket) => {
			peer = socket;
			socket.on("error", () => {});
			socket.write(`${"x".repeat(MAX_FRAMED_LINE_BYTES + 1)}\n`);
		});
		sockets.push(server);
		await new Promise<void>((resolve) =>
			server.listen(boundUnixSocketPath(endpoint), resolve),
		);
		const result = await requestWarmAnalyze(cwd, "/w/a.ts", 600_000);
		peer?.destroy();
		expect(result).toBeUndefined();
		const row = overflowRow();
		expect(row?.count).toBe(1);
		expect(row?.latestReasons[0]?.subject).toBe("warm-analyze-reply");
		expect(row?.latestReasons[0]?.reason).toContain(
			"discarded a complete line",
		);
	});

	it("gives up on the bound rather than on the timeout when the reply never frames", async () => {
		const endpoint = ipcPathForCwd(cwd);
		try {
			fs.unlinkSync(endpoint);
		} catch {
			// no stale socket
		}
		const chunk = "x".repeat(4 * MiB);
		const server = net.createServer((socket) => {
			// The client destroys the connection the moment the bound fires, which
			// resets this write — the peer's problem, not the reader's.
			socket.on("error", () => {});
			let sent = 0;
			const pump = () => {
				if (sent > MAX_FRAMED_LINE_BYTES + 4 * MiB) return;
				sent += chunk.length;
				if (socket.write(chunk)) setImmediate(pump);
				else socket.once("drain", pump);
			};
			pump();
		});
		sockets.push(server);
		await new Promise<void>((resolve) =>
			server.listen(boundUnixSocketPath(endpoint), resolve),
		);

		// The timeout is 10 minutes: if the bound does not fire, this test hangs
		// until vitest kills it rather than passing on a timeout that hid the bug.
		const result = await requestWarmAnalyze(cwd, "/w/a.ts", 600_000);
		expect(result).toBeUndefined();
		const row = overflowRow();
		expect(row?.count).toBe(1);
		expect(row?.latestReasons[0]?.subject).toBe("warm-analyze-reply");
	});
});
