// #3827: a real language-client stamp must reach the real rename capture, so
// this file spawns the fake LSP server through `launchLSP` and drives
// `lsp_navigation rename` against a real `createLSPClient`. Admitted to the
// serialized lsp-spawn-heavy lane (vitest.config.ts) for the same reason as
// tests/tools/lsp-diagnostics-2776.test.ts: a real initialize handshake.
/**
 * #3827: `lsp_navigation`'s rename refused a valid rename when a file was
 * opened for the first time after the server computed the edit. A first
 * `didOpen` has no previous send record, so the client stamps it as "changed
 * now"; the #3736 staleness check read that stamp as a write after the
 * request, although no byte changed. The client here is the real
 * `createLSPClient` (the real stamp in `recordSentContent`), the tool and its
 * apply are the real ones, and only the `LSPService` shell around the client
 * is a double, as in tests/tools/lsp-navigation-rename-staleness.test.ts.
 *
 * State table (the file the rename edit also writes, `b.ts`, aged an hour so
 * the unopened mtime rule has nothing to say about it unless the test writes):
 *
 *  | b.ts before compute | after compute                    | expected |
 *  |---------------------|----------------------------------|----------|
 *  | opened              | nothing                          | applies  |
 *  | opened              | rewritten and re-synced          | refused  |
 *  | opened              | rewritten (old mtime), re-synced | refused  |
 *  | never opened        | nothing                          | applies  |
 *  | never opened        | first opened, bytes unchanged    | applies  |
 *  | written after client start (old mtime), first opened | refused |
 *  | written within the margin before client start, first opened | refused |
 *  | never opened        | rewritten, then first opened     | refused  |
 *  | never opened        | first opened, then rewritten+sync| refused  |
 *  | never opened        | first opened, then rewritten (old mtime), no sync | refused |
 *  | never opened        | first opened, then rewritten (old mtime), re-synced | refused |
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { spawnFakeLspServer } from "../support/fake-lsp-server.js";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { createLSPClient } from "../../clients/lsp/client.js";
import { stopLSP } from "../../clients/lsp/launch.js";
import { setHostFileMutationQueueLoader } from "../../clients/file-mutation-queue.js";
import { resetDegradationLedger } from "../../clients/degradation-ledger.js";

const lsp = vi.hoisted(() => ({ service: undefined as unknown }));
vi.mock("../../clients/lsp/capabilities.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/lsp/capabilities.js")
	>()),
	getLSPService: () => lsp.service,
}));

import { createLspNavigationTool } from "../../tools/lsp-navigation.js";

function gate() {
	let open!: () => void;
	const p = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { p, open };
}

let env: ReturnType<typeof setupTestEnvironment>;
let fileA: string;
let fileB: string;
let clientStartMs: number;
let client: Awaited<ReturnType<typeof createLSPClient>>;
let proc: Awaited<ReturnType<typeof spawnFakeLspServer>>;

const edit = () => ({
	changes: Object.fromEntries(
		[fileA, fileB].map((file) => [
			pathToFileURL(file).href,
			[
				{
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 5 },
					},
					newText: "let",
				},
			],
		]),
	),
});

/** What production's `touchFile` does to the client: the real open or change. */
const touch = (file: string, content: string) =>
	client.notify.open(file, content, "typescript");

/**
 * Opens `file` as the client would have a minute ago, so the record's first
 * send is strictly older than any rename request this test then makes (a tie
 * would hand the file to the unopened rule). No timer: only the stamp's clock.
 */
async function openLongAgo(file: string, content: string) {
	const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() - 60_000);
	try {
		await touch(file, content);
	} finally {
		now.mockRestore();
	}
}

/** The agent's write: queued like pi's own, then synced by its hook. */
async function agentWrite(file: string, content: string, sync: boolean) {
	await withFileMutationQueue(file, async () => {
		fs.writeFileSync(file, content);
	});
	if (sync) await touch(file, content);
}

/**
 * Runs `lsp_navigation rename` (apply) with `betweenComputeAndApply` run
 * while the server's answer is parked, i.e. after the rename was requested.
 */
async function renameWith(
	betweenComputeAndApply: () => Promise<void>,
): Promise<{ isError?: boolean; text: string }> {
	const parked = gate();
	const resume = gate();
	lsp.service = makeLspServiceDouble({
		supportsLSP: () => true,
		hasLSP: async () => true,
		touchFile: vi.fn(async (file: string, content: string) => {
			await touch(file, content);
			return { diags: [] };
		}),
		getTrackedContent: (file: string) => client.getSentContent?.(file),
		rename: async () => {
			parked.open();
			await resume.p;
			return edit();
		},
	});
	const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
	const pending = tool.execute(
		"rename-3827",
		{
			operation: "rename",
			path: fileA,
			line: 1,
			character: 1,
			newName: "let",
			apply: true,
		},
		new AbortController().signal,
		null,
		{ cwd: env.tmpDir },
	) as Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
	await parked.p;
	await betweenComputeAndApply();
	resume.open();
	const result = await pending;
	return { isError: result.isError, text: String(result.content[0]?.text) };
}

beforeEach(async () => {
	resetDegradationLedger();
	env = setupTestEnvironment("pi-lens-lsp-nav-first-open-");
	fileA = path.join(env.tmpDir, "a.ts");
	fileB = path.join(env.tmpDir, "b.ts");
	fs.writeFileSync(fileA, "const = 1;\n");
	fs.writeFileSync(fileB, "const = 2;\n");
	// Unwritten for an hour: the unopened mtime rule passes it.
	const old = new Date(Date.now() - 3_600_000);
	fs.utimesSync(fileB, old, old);
	setHostFileMutationQueueLoader(async () => ({ withFileMutationQueue }));
	proc = await spawnFakeLspServer({ cwd: env.tmpDir });
	// A client started a minute ago, so the files this test writes "after the
	// client started" can still be older than the rename request's margin.
	clientStartMs = Date.now() - 60_000;
	const startClock = vi.spyOn(Date, "now").mockReturnValue(clientStartMs);
	try {
		client = await createLSPClient({
			serverId: "fake-3827",
			process: proc,
			root: env.tmpDir,
		});
	} finally {
		startClock.mockRestore();
	}
});

afterEach(async () => {
	lsp.service = undefined;
	vi.restoreAllMocks();
	setHostFileMutationQueueLoader(undefined);
	await client.shutdown().catch(() => {});
	await stopLSP(proc).catch(() => {});
	env.cleanup();
});

describe("#3827: a first open after the rename was computed is not a change", () => {
	it("a file first opened after compute with the bytes the disk always held is renamed", async () => {
		const result = await renameWith(async () => {
			await touch(fileB, "const = 2;\n");
		});

		// Pre-fix: the first didOpen stamps b.ts at or after the request and the
		// capture refuses it: "it changed after the language server computed...".
		expect(result.text).not.toContain("language server computed the rename");
		expect(result.isError).toBeUndefined();
		expect(fs.readFileSync(fileA, "utf8")).toBe("let = 1;\n");
		expect(fs.readFileSync(fileB, "utf8")).toBe("let = 2;\n");
	});

	it("a file first opened in the very millisecond the rename was requested is held to the unopened rule", async () => {
		// Recurrence guarded: the `>=` tie. A first send stamped in T's own tick
		// may precede or follow the request, so the unopened rule (here: mtime an
		// hour old) judges it, not the send stamp, which equals T.
		vi.spyOn(Date, "now").mockReturnValue(Date.now());
		const result = await renameWith(async () => {
			await touch(fileB, "const = 2;\n");
		});

		expect(result.text).not.toContain("language server computed the rename");
		expect(result.isError).toBeUndefined();
		expect(fs.readFileSync(fileB, "utf8")).toBe("let = 2;\n");
	});

	it("a file written after compute and then first opened is refused, and its bytes survive", async () => {
		// Recurrence guarded: the fix over-widening into "any first open passes".
		const result = await renameWith(async () => {
			await agentWrite(fileB, "AGENT = 8;\n", true);
		});

		expect(result.isError).toBe(true);
		expect(result.text).toContain("b.ts");
		expect(fs.readFileSync(fileB, "utf8")).toBe("AGENT = 8;\n");
		expect(fs.readFileSync(fileA, "utf8")).toBe("const = 1;\n");
	});

	it("a file pi wrote after the client started, more than the margin before the request, whose sync is the first open in the window, is refused", async () => {
		// Recurrence guarded: review r1 F1 (probe P1). The server holds its
		// load-time copy of a never-opened file; the pipeline's sync is the first
		// send and carries bytes it never saw. Master refused it by the stamp, the
		// first #3827 rule applied it at the server's offsets ("let9;").
		fs.writeFileSync(fileB, "PI = 9;\n");
		const tenSecondsAgo = new Date(Date.now() - 10_000);
		fs.utimesSync(fileB, tenSecondsAgo, tenSecondsAgo);
		const result = await renameWith(async () => {
			await touch(fileB, "PI = 9;\n");
		});

		expect(result.isError).toBe(true);
		expect(result.text).toContain("b.ts");
		expect(fs.readFileSync(fileB, "utf8")).toBe("PI = 9;\n");
		expect(fs.readFileSync(fileA, "utf8")).toBe("const = 1;\n");
	});

	it("a file last written within the margin before the client started is not held to be quiet since it, and its first open is refused", async () => {
		// Recurrence guarded: the margin on the client-start comparison. A
		// coarse-timestamp filesystem can stamp a write after the start up to the
		// margin early; a bare `mtime < start` would exempt it.
		const justBeforeStart = new Date(clientStartMs - 1_000);
		fs.utimesSync(fileB, justBeforeStart, justBeforeStart);
		const result = await renameWith(async () => {
			await touch(fileB, "const = 2;\n");
		});

		expect(result.isError).toBe(true);
		expect(result.text).toContain("b.ts");
		expect(fs.readFileSync(fileB, "utf8")).toBe("const = 2;\n");
	});

	it("a file first opened after compute and rewritten and re-synced is refused", async () => {
		// The first open does not excuse a later real change: the unopened-file
		// mtime rule still sees the write.
		const result = await renameWith(async () => {
			await touch(fileB, "const = 2;\n");
			await agentWrite(fileB, "AGENT = 7;\n", true);
		});

		expect(result.isError).toBe(true);
		expect(result.text).toContain("b.ts");
		expect(fs.readFileSync(fileB, "utf8")).toBe("AGENT = 7;\n");
		expect(fs.readFileSync(fileA, "utf8")).toBe("const = 1;\n");
	});

	it("a file first opened after compute and then rewritten keeping its old mtime, with no resync, is refused", async () => {
		// Recurrence guarded: verify r2 F4 (probe P7). The quiet exemption once
		// dropped the whole send check, so the disk was never compared with the
		// first open's bytes; the old mtime passed the unopened rule and the
		// server's offsets landed on the new bytes ("let 77;").
		const result = await renameWith(async () => {
			await touch(fileB, "const = 2;\n");
			fs.writeFileSync(fileB, "EXT = 77;\n");
			const old = new Date(Date.now() - 3_600_000);
			fs.utimesSync(fileB, old, old);
		});

		expect(result.isError).toBe(true);
		expect(result.text).toContain(
			"b.ts: it changed after the language client first opened it",
		);
		expect(fs.readFileSync(fileB, "utf8")).toBe("EXT = 77;\n");
		expect(fs.readFileSync(fileA, "utf8")).toBe("const = 1;\n");
	});

	it("a file first opened after compute and then rewritten keeping its old mtime and re-synced is refused", async () => {
		// Recurrence guarded: round-3 state table row B11 (probe P9). The resync
		// makes the disk equal the last send, so the hash check alone passes; a
		// record whose bytes changed after its first send is not quiet, although
		// the mtime says so.
		const result = await renameWith(async () => {
			await touch(fileB, "const = 2;\n");
			fs.writeFileSync(fileB, "EXT = 78;\n");
			const old = new Date(Date.now() - 3_600_000);
			fs.utimesSync(fileB, old, old);
			await touch(fileB, "EXT = 78;\n");
		});

		expect(result.isError).toBe(true);
		expect(result.text).toContain(
			"b.ts: it changed after the language client first opened it",
		);
		expect(fs.readFileSync(fileB, "utf8")).toBe("EXT = 78;\n");
		expect(fs.readFileSync(fileA, "utf8")).toBe("const = 1;\n");
	});

	it("a file opened before compute and rewritten and re-synced after it is refused", async () => {
		// Recurrence guarded: #3601 round 4, the opened-file stamp check.
		await openLongAgo(fileB, "const = 2;\n");
		const result = await renameWith(async () => {
			await agentWrite(fileB, "AGENT = 6;\n", true);
		});

		expect(result.isError).toBe(true);
		expect(result.text).toContain("b.ts");
		expect(fs.readFileSync(fileB, "utf8")).toBe("AGENT = 6;\n");
	});

	it("a file opened before compute, rewritten after it keeping its old mtime, and re-synced is refused", async () => {
		// Recurrence guarded: #3747's mtime-kept write. Only the client's own
		// record (opened before the request, then changed) can see it; the
		// unopened-file mtime rule is blind, so a first-open exemption keyed on
		// anything but the FIRST send (a refreshed `openedAtMs`) applies it.
		await openLongAgo(fileB, "const = 2;\n");
		const result = await renameWith(async () => {
			fs.writeFileSync(fileB, "EXT = 55;\n");
			const old = new Date(Date.now() - 3_600_000);
			fs.utimesSync(fileB, old, old);
			await touch(fileB, "EXT = 55;\n");
		});

		expect(result.isError).toBe(true);
		expect(result.text).toContain("b.ts");
		expect(fs.readFileSync(fileB, "utf8")).toBe("EXT = 55;\n");
	});

	it("a file opened before compute and untouched is renamed", async () => {
		await openLongAgo(fileB, "const = 2;\n");
		const result = await renameWith(async () => {});

		expect(result.isError).toBeUndefined();
		expect(fs.readFileSync(fileB, "utf8")).toBe("let = 2;\n");
	});

	it("a file never opened and untouched is renamed", async () => {
		const result = await renameWith(async () => {});

		expect(result.isError).toBeUndefined();
		expect(fs.readFileSync(fileB, "utf8")).toBe("let = 2;\n");
	});
});
