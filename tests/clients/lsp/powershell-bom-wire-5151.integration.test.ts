/**
 * #5151: the bytes of a PowerShell BOM file that actually leave the process.
 *
 * Recurrence this file prevents: a unit-level assertion on the notification
 * object cannot see a transport that re-encodes it. This file drives the real
 * `createLSPClient` against the fixture server over a real JSON-RPC stdio
 * stream and reads what the server received. A real child is required: only
 * the stream proves that U+FEFF reaches the server as document text, and that
 * another server's text is left alone. It is admitted to the lsp-spawn-heavy
 * lane (vitest.config.ts) because it spawns the fixture and waits on its
 * handshake. The per-notification detail lives in
 * `powershell-bom-wire-5151.test.ts`.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLSPClient } from "../../../clients/lsp/client.js";
import { stopLSP } from "../../../clients/lsp/launch.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";

const BOM = "\uFEFF";
// CRLF, non-ASCII (BMP and astral) and an INTERIOR U+FEFF.
const BODY =
	'Write-Host "héllo ✓ 日本 😀"\r\nfunction Get-Thing {\r\n  "a\uFEFFb"\r\n}\r\n';
const SECOND_BODY = `${BODY}Get-Thing\r\n`;

describe("#5151 the bytes that leave the process", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0))
			fs.rmSync(dir, { recursive: true, force: true });
	});

	const sha12 = (text: string) =>
		createHash("sha256").update(text).digest("hex").slice(0, 12);

	async function openAndChange(serverId: string) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-bom-5151-"));
		dirs.push(dir);
		const trace = path.join(dir, "wire.trace");
		const proc = await spawnFakeLspServer({
			cwd: dir,
			env: {
				...process.env,
				FAKE_LSP_TRACE_FILE: trace,
				FAKE_LSP_TRACE_TEXT: "1",
				FAKE_LSP_ECHO_DID_CHANGE: "1",
			},
		});
		const client = await createLSPClient({
			serverId,
			process: proc,
			root: dir,
		});
		try {
			// The server handles notifications in order and traces the open before it
			// echoes the change, so the echo is the signal that the trace is complete.
			let gotChange: (text: string) => void = () => {};
			const changeText = new Promise<string>((resolve) => {
				gotChange = resolve;
			});
			client.connection.onNotification(
				"$/test/didChangeReceived",
				(params: { contentChanges: Array<{ text: string }> }) => {
					gotChange(params.contentChanges[0].text);
				},
			);
			const file = path.join(dir, "script.ps1");
			await client.notify.open(file, BOM + BODY, "powershell");
			await client.notify.change(file, BOM + SECOND_BODY);
			const echoed = [await changeText];
			const lines = fs
				.readFileSync(trace, "utf8")
				.split("\n")
				.filter((line) => line.startsWith("text "));
			return { echoed, lines };
		} finally {
			await client.shutdown().catch(() => {});
			await stopLSP(proc).catch(() => {});
		}
	}

	it("a powershell server reads the replaced text from the JSON-RPC stream", async () => {
		const { echoed, lines } = await openAndChange("powershell");
		expect(lines[0]?.endsWith(sha12(` ${BODY}`))).toBe(true);
		expect(echoed[0]).toBe(` ${SECOND_BODY}`);
	}, 20_000);

	it("another server's stream still carries the BOM", async () => {
		const { echoed, lines } = await openAndChange("fake-other");
		expect(lines[0]?.endsWith(sha12(BOM + BODY))).toBe(true);
		expect(echoed[0]).toBe(BOM + SECOND_BODY);
	}, 20_000);
});
