/**
 * #2436 review-round fidelity proof: `spawnFakeLspServer`'s `onTestFinished`
 * backstop kill (tests/support/fake-lsp-server.ts) had zero test pinning it —
 * every consuming test happens to call its own kill/cleanup, so a refactor
 * that silently dropped the registration would go unnoticed until the exact
 * shape #2436 found: a test whose own cleanup never runs, leaking the
 * fixture. This pins the backstop directly: test A spawns via the helper and
 * deliberately never kills the process; test B (which runs after test A
 * finishes, since vitest runs `it` blocks in a `describe` sequentially by
 * default) asserts test A's child is already dead — proof the
 * `onTestFinished` hook, not some incidental cleanup, did the killing.
 *
 * Deliberately no `afterEach` here: an `afterEach` registered in this file
 * would race the very backstop under test (both would fire once test A
 * finishes) and could mask a broken backstop by killing the leaked process
 * before test B gets to look at it. The only cleanup is an `afterAll`, which
 * runs strictly after test B's assertion has already been made.
 */
import { afterAll, describe, expect, it } from "vitest";
import { waitFor } from "../clients/interleaving-kit.js";
import { stopLSP } from "../../clients/lsp/launch.js";
import { spawnFakeLspServer } from "./fake-lsp-server.js";

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntil(
	predicate: () => boolean,
	timeoutMs: number,
	stepMs = 50,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
	return predicate();
}

describe("spawnFakeLspServer — onTestFinished backstop (#2436)", () => {
	let leakedPid: number | undefined;

	afterAll(() => {
		// Sweep only if the backstop under test actually failed (mutation
		// runs, or a genuine regression) — the passing case has already
		// reaped this before we get here, making this a no-op.
		if (leakedPid !== undefined && isAlive(leakedPid)) {
			try {
				process.kill(leakedPid, "SIGKILL");
			} catch {
				/* already gone */
			}
		}
	});

	it("spawns the fixture and deliberately does not kill it", async () => {
		const proc = await spawnFakeLspServer();
		const pid = proc.process.pid;
		expect(pid).toBeDefined();
		expect(isAlive(pid as number)).toBe(true);
		leakedPid = pid;
		// No kill() here on purpose — the onTestFinished backstop registered
		// inside spawnFakeLspServer is the only thing that should reap this.
	});

	it("the backstop reaped the previous test's process once it finished", async () => {
		expect(leakedPid).toBeDefined();
		const died = await waitUntil(
			() => !isAlive(leakedPid as number),
			2_000,
			50,
		);
		expect(died).toBe(true);
	});
});

type OrderingFrame = {
	id?: number;
	method?: string;
	params?: { version?: number; response?: string };
	result?: { items?: unknown[] };
	error?: { code?: number };
};

const ORDERING_URI = "file:///fixture-2824.ts";

function orderingFrame(message: Record<string, unknown>): Buffer {
	const body = JSON.stringify(message);
	return Buffer.from(
		`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`,
		"utf8",
	);
}

async function startOrderingFixture(env: Record<string, string>) {
	const proc = await spawnFakeLspServer({ env: { ...process.env, ...env } });
	const frames: OrderingFrame[] = [];
	let buffer = Buffer.alloc(0);
	proc.stdout.on("data", (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		while (true) {
			const headerEnd = buffer.indexOf("\r\n\r\n");
			if (headerEnd < 0) return;
			const header = buffer.subarray(0, headerEnd).toString("utf8");
			const length = /Content-Length:\s*(\d+)/i.exec(header);
			if (!length) throw new Error(`missing Content-Length in ${header}`);
			const bodyEnd = headerEnd + 4 + Number(length[1]);
			if (buffer.length < bodyEnd) return;
			frames.push(
				JSON.parse(buffer.subarray(headerEnd + 4, bodyEnd).toString("utf8")),
			);
			buffer = buffer.subarray(bodyEnd);
		}
	});
	const write = (message: Record<string, unknown>) =>
		(
			proc.stdin as NodeJS.WritableStream & { write: (data: Buffer) => void }
		).write(orderingFrame(message));
	write({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: { capabilities: {} },
	});
	await waitFor(
		() => frames,
		(value) => value.some((frame) => frame.id === 1),
	);
	write({ jsonrpc: "2.0", method: "initialized", params: {} });
	write({
		jsonrpc: "2.0",
		method: "textDocument/didOpen",
		params: {
			textDocument: { uri: ORDERING_URI, version: 1, text: "const x = 1;" },
		},
	});
	write({
		jsonrpc: "2.0",
		id: 2,
		method: "textDocument/diagnostic",
		params: { textDocument: { uri: ORDERING_URI } },
	});
	return { proc, frames };
}

describe("fake LSP pull/push ordering controls (#2824)", () => {
	const waitForCompletion = (frames: OrderingFrame[]) =>
		waitFor(
			() => frames,
			(value) => value.some((frame) => frame.method === "$/test/pullCompleted"),
		);

	it("pushBeforePullResponse emits the push before the pull response", async () => {
		const { proc, frames } = await startOrderingFixture({
			FAKE_LSP_PUSH_BEFORE_PULL_RESPONSE: "1",
			FAKE_LSP_PULL_COMPLETION: "1",
		});
		try {
			await waitForCompletion(frames);
			const ordered = frames.filter(
				(frame) =>
					frame.method === "textDocument/publishDiagnostics" || frame.id === 2,
			);
			expect(ordered[0]?.method).toBe("textDocument/publishDiagnostics");
			expect(ordered[1]?.id).toBe(2);
		} finally {
			await stopLSP(proc).catch(() => {});
		}
	});

	it("pushAfterPullResponse emits the pull response before the push", async () => {
		const { proc, frames } = await startOrderingFixture({
			FAKE_LSP_PUSH_AFTER_PULL_RESPONSE: "1",
			FAKE_LSP_PULL_COMPLETION: "1",
		});
		try {
			await waitForCompletion(frames);
			const ordered = frames.filter(
				(frame) =>
					frame.method === "textDocument/publishDiagnostics" || frame.id === 2,
			);
			expect(ordered[0]?.id).toBe(2);
			expect(ordered[1]?.method).toBe("textDocument/publishDiagnostics");
		} finally {
			await stopLSP(proc).catch(() => {});
		}
	});

	it("pushWithVersion carries the configured document version", async () => {
		const { proc, frames } = await startOrderingFixture({
			FAKE_LSP_PUSH_AFTER_PULL_RESPONSE: "1",
			FAKE_LSP_PUSH_VERSION: "7",
			FAKE_LSP_PULL_COMPLETION: "1",
		});
		try {
			await waitForCompletion(frames);
			expect(
				frames.find(
					(frame) => frame.method === "textDocument/publishDiagnostics",
				)?.params?.version,
			).toBe(7);
		} finally {
			await stopLSP(proc).catch(() => {});
		}
	});

	it.each([
		[
			"-32601",
			(frame: OrderingFrame | undefined) => frame?.error?.code === -32601,
		],
		["timeout", (frame: OrderingFrame | undefined) => frame === undefined],
		[
			"items",
			(frame: OrderingFrame | undefined) => frame?.result?.items?.length === 1,
		],
		[
			"empty",
			(frame: OrderingFrame | undefined) => frame?.result?.items?.length === 0,
		],
	] as const)(
		"respondPullWith(%s) returns the requested pull outcome",
		async (response, matches) => {
			const { proc, frames } = await startOrderingFixture({
				FAKE_LSP_RESPOND_PULL_WITH: response,
				FAKE_LSP_PULL_COMPLETION: "1",
			});
			try {
				await waitForCompletion(frames);
				expect(matches(frames.find((frame) => frame.id === 2))).toBe(true);
			} finally {
				await stopLSP(proc).catch(() => {});
			}
		},
	);

	it("signals pull completion only after the controlled operation is observable", async () => {
		const { proc, frames } = await startOrderingFixture({
			FAKE_LSP_PUSH_BEFORE_PULL_RESPONSE: "1",
			FAKE_LSP_PULL_COMPLETION: "1",
		});
		try {
			const completion = await waitFor(
				() => frames.find((frame) => frame.method === "$/test/pullCompleted"),
				(frame) => frame !== undefined,
			);
			expect(completion?.params?.response).toBe("default");
			expect(
				frames.some(
					(frame) => frame.method === "textDocument/publishDiagnostics",
				),
			).toBe(true);
		} finally {
			await stopLSP(proc).catch(() => {});
		}
	});
});
