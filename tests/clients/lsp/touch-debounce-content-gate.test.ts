/**
 * #4532 gap 9 — the touch debounce must decide by the bytes the client holds,
 * not by how long ago the last push was.
 *
 * Recurrence this file prevents: `shouldSkipNotify` gated the "same content
 * was already pushed" skip on `now - previous.touchedAt <= TOUCH_DEBOUNCE_MS`
 * and only then compared fingerprints. A touch whose own work outlived the
 * window (an auxiliary spawn, a paced scanner write) made the NEXT touch of
 * byte-identical content look stale by elapsed time alone, so the identical
 * bytes went out again — and a `didChange` on unchanged content clears the
 * server's cached diagnostics and restarts computation (#4527 measured the
 * equivalent re-push as a 2335 ms cold `lsp_diagnostics_timeout` on clangd,
 * which does not republish for identical bytes).
 *
 * Everything here is the production path: the real `LSPService`, the real
 * client (whose own sent-content record is the evidence the gate must read),
 * the real per-document notify queue, and a real stdio JSON-RPC wire to the
 * shared fake LSP child. Only the server binary is a fake, and the trace is
 * the witness: "no push" means the SERVER received nothing, not that pi-lens
 * skipped its own bookkeeping.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hashDiagnosticContent } from "../../../clients/lsp/diagnostic-binding.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../test-utils.js";

// `clients/lsp/index.js` reads this once at module load, so it is set before
// any import of that module is evaluated (every load below is dynamic).
vi.hoisted(() => {
	process.env.PI_LENS_LSP_TOUCH_DEBOUNCE_MS = "150";
});

const fakeServer = fileURLToPath(
	new URL("../../fixtures/fake-lsp-server.mjs", import.meta.url),
);
const PREFIX = "pi-lens-4532-touch-debounce-";
const env = setupTestEnvironment(PREFIX);
/** The window the fix must stop deciding by. */
const WINDOW_MS = 150;
const TOUCH = {
	diagnostics: "none",
	clientScope: "primary",
	source: "lsp_sync",
} as const;
const HELD = "export const held = 1;\n";
const CHANGED = "export const held = 2;\n";

let dir = "";
let traceFile = "";

async function service() {
	const lsp = await import("../../../clients/lsp/index.js");
	return lsp.getLSPService();
}

function traceLines(): string[] {
	return fs.existsSync(traceFile)
		? fs.readFileSync(traceFile, "utf8").split("\n").filter(Boolean)
		: [];
}

/**
 * Ask the server for an answer now, then return the trace length. The child
 * reads stdin in order over one ordered stream, so every notification written
 * before this call is traced before the request is answered; a plain read of
 * the trace races the child process. The request's own line is filtered out by
 * {@link documents}.
 */
async function fence(file: string): Promise<number> {
	await (await service()).documentSymbol(file);
	return traceLines().length;
}

const uri = (file: string) => pathToFileURL(file).href;

/** Document notifications only: the wire's answer to "did the server get it". */
const documents = (lines: readonly string[]) =>
	lines.filter((line) =>
		/^recv textDocument\/did(Open|Change|Save|Close) /.test(line),
	);

/** What each didOpen/didChange carried, as the fake server's 12-hex sha. */
const texts = (lines: readonly string[]) =>
	lines.filter((line) => line.startsWith("text "));

/** The bytes a didOpen/didChange carried, as the fake server traced them. */
const textLine = (file: string, content: string) =>
	`text ${uri(file)} ${createHash("sha256")
		.update(content)
		.digest("hex")
		.slice(0, 12)}`;

/**
 * Run `act` with the clock already past the debounce window. Only `Date` is
 * faked — the notify queue's real timers, the stdio wire and the child process
 * keep running — so the window is exceeded without a sleep and without holding
 * a real timeout, and the assertion is about content, never about time.
 */
async function pastWindow(act: () => Promise<unknown>): Promise<void> {
	vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + WINDOW_MS * 10 });
	try {
		await act();
	} finally {
		vi.useRealTimers();
	}
}

function pathFor(tag: string): string {
	return path.join(dir, `${tag}.ts`);
}

describe("#4532 gap 9 — the touch debounce reads the client's content record", () => {
	beforeAll(async () => {
		setProjectTrustState("trusted");
		dir = path.join(env.tmpDir, "proj");
		fs.mkdirSync(path.join(dir, ".pi-lens"), { recursive: true });
		fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
		// Every fixture file exists BEFORE the client starts, so the client
		// announces it as Changed rather than Created. A Created this client sent
		// since the push legitimately re-pushes the same bytes (#4320), and those
		// cases are separate; this file is about the content gate alone.
		for (const tag of ["warm", "identical", "changed", "reopened"])
			fs.writeFileSync(pathFor(tag), HELD);
		traceFile = path.join(env.tmpDir, "wire.trace");
		const shim = path.join(env.tmpDir, "server.mjs");
		fs.writeFileSync(
			shim,
			[
				'process.env.FAKE_LSP_NO_DIAGNOSTIC_PROVIDER = "1";',
				'process.env.FAKE_LSP_TRACE_TEXT = "1";',
				`process.env.FAKE_LSP_TRACE_FILE = ${JSON.stringify(traceFile)};`,
				`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
				"",
			].join("\n"),
		);
		fs.writeFileSync(
			path.join(dir, ".pi-lens", "lsp.json"),
			JSON.stringify({
				servers: {
					"fake-ts": {
						name: "fake",
						extensions: [".ts"],
						command: process.execPath,
						args: [shim],
						rootMarkers: ["package.json"],
					},
				},
				disabledServers: [
					"typescript",
					"deno",
					"python",
					"python-jedi",
					"opengrep",
					"ast-grep",
					"typos",
				],
			}),
		);
		const config = await import("../../../clients/lsp/config.js");
		await config.initLSPConfig(dir);
		// Start the one client this project needs with its start stamp a few
		// seconds AFTER the fixture file births, so `watchedTypeForOpen` reads
		// them as files the server already knew (its margin is 100 ms). Only
		// `Date` is faked: the spawn, the handshake and the wire stay real.
		vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 4000 });
		try {
			await (await service()).documentSymbol(pathFor("warm"));
		} finally {
			vi.useRealTimers();
		}
	});

	afterAll(async () => {
		await cleanupTestEnvironmentsDrained(PREFIX, {
			beforeDrain: async () => {
				await (await service()).shutdown();
			},
		});
		resetProjectTrust();
	});

	// The defect: identical bytes, pushed once, then offered again after the
	// window. Pre-fix the second offer re-pushed them and cleared the server's
	// diagnostics for content it already had.
	it("leaves the server's bytes alone when only the elapsed window has passed", async () => {
		const svc = await service();
		const file = pathFor("identical");
		const opened = traceLines().length;
		await svc.touchFile(file, HELD, TOUCH);
		const firstPush = await fence(file);
		expect(documents(traceLines().slice(opened))).toEqual([
			`recv textDocument/didOpen ${uri(file)}`,
		]);
		// The gate's own evidence: the client records holding exactly these bytes.
		expect(svc.getTrackedContent(file, dir)?.hash).toBe(
			hashDiagnosticContent(HELD),
		);

		await pastWindow(() => svc.touchFile(file, HELD, TOUCH));

		const secondPush = await fence(file);
		expect(documents(traceLines().slice(firstPush, secondPush))).toEqual([]);
	});

	// The other direction of the same gate: a content record that disagrees
	// with the bytes must still push after the window.
	it("pushes changed bytes after the window", async () => {
		const svc = await service();
		const file = pathFor("changed");
		await svc.touchFile(file, HELD, TOUCH);
		const mark = await fence(file);

		fs.writeFileSync(file, CHANGED);
		await pastWindow(() => svc.touchFile(file, CHANGED, TOUCH));

		await fence(file);
		const lines = traceLines().slice(mark);
		expect(documents(lines)).toEqual([
			`recv textDocument/didChange ${uri(file)}`,
		]);
		expect(texts(lines)).toEqual([textLine(file, CHANGED)]);
		expect(svc.getTrackedContent(file, dir)?.hash).toBe(
			hashDiagnosticContent(CHANGED),
		);
	});

	// A document closed and reopened inside the window: didClose drops the
	// client's record, so nothing proves the server still holds the bytes and
	// the reopen must push.
	it("pushes a document again after it was closed and reopened", async () => {
		const svc = await service();
		const file = pathFor("reopened");
		await svc.touchFile(file, HELD, TOUCH);
		const entry = await svc.getClientForFile(file);
		expect(
			entry?.client,
			"the case needs the file's live client",
		).toBeDefined();
		const mark = await fence(file);

		await entry!.client.closeDocument(file);
		await svc.touchFile(file, HELD, TOUCH);

		await fence(file);
		const lines = traceLines().slice(mark);
		expect(documents(lines)).toEqual([
			`recv textDocument/didClose ${uri(file)}`,
			`recv textDocument/didOpen ${uri(file)}`,
		]);
		expect(texts(lines)).toEqual([textLine(file, HELD)]);
	});
});
